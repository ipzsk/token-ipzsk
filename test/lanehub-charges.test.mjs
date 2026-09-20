import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaToCny, recordLanehubCharge } from '../src/lanehub-charges.mjs';

// 补记账单用的内存库：只认这两条语句。
function fakeDb() {
  const billing = [];
  const db = {
    billing,
    tx: (work) => work(db),
    async query(sql, args = []) {
      if (/INSERT INTO request_billing/.test(sql)) {
        if (billing.some((b) => b.request_id === args[0])) return { rowCount: 0, rows: [] };
        // released 那条 SQL 把金额写死成 0，参数里只有快照——两种形状别混着读。
        const settled = /'settled'/.test(sql);
        billing.push({ request_id: args[0], user_id: args[1], state: settled ? 'settled' : 'released',
          amount: settled ? args[2] : 0, snapshot: settled ? args[3] : args[2] });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO plugin_earnings/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    },
  };
  return db;
}
const fakeLanehub = (logs) => ({ seen: [], call(path) { this.seen.push(path); return { data: logs } },
  usdRate: async () => 7,
  addQuota(...args) { this.seen.push('addQuota'); return args; } });

const RATES = { usdCnyRate: 7, quotaPerUnit: 500000 };
const request = { id: 'r1', user_id: 'u1', model: 'gpt-image-2', upstream_id: 'req-abc', completed_at: new Date() };

// 折算是钱：500000 quota = 1 美元 = 7 块，8 位小数不能丢。
test('quota 折人民币：整数与零头都要对', () => {
  assert.equal(quotaToCny(500000, 7, 500000), '7.00000000');
  assert.equal(quotaToCny(50000, '7.0', 500000), '0.70000000');
  assert.equal(quotaToCny(1, 7, 500000), '0.00001400');
  assert.equal(quotaToCny(0, 7, 500000), '0.00000000');
});

// 这条不成立，插件作者的分成就永远是 0——整个变现模型挂在这张表上。
test('按 request_id 查到消费日志就写一条 settled 账单', async () => {
  const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 28508 }]);
  assert.equal(await recordLanehubCharge(db, lanehub, request, RATES), 'settled');
  assert.equal(db.billing.length, 1);
  assert.equal(db.billing[0].state, 'settled');
  assert.equal(db.billing[0].amount, quotaToCny(28508, 7, 500000));
  assert.match(lanehub.seen[0], /request_id=req-abc/);
});

test('同一个请求重复补记只会有一行', async () => {
  const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 100 }]);
  await recordLanehubCharge(db, lanehub, request, RATES);
  await recordLanehubCharge(db, lanehub, request, RATES);
  assert.equal(db.billing.length, 1);
});

// 重试写了两条日志时取第一条会少收钱，所以按总和算。
test('多条消费日志按总和计，非消费类型不计', async () => {
  const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 100 }, { type: 1, quota: 999 }, { type: 2, quota: 50 }]);
  await recordLanehubCharge(db, lanehub, request, RATES);
  assert.equal(db.billing[0].amount, quotaToCny(150, 7, 500000));
});

// 查不到日志的两种情况必须分开：刚完成的等下一轮，超时的落成 released 终止重试，
// 否则失败的请求会被永远重查，把每轮的 20 个名额占满。
test('日志还没落库时不写行，超时之后写 released 终止重试', async () => {
  const fresh = fakeDb(), old = fakeDb(), empty = () => fakeLanehub([]);
  assert.equal(await recordLanehubCharge(fresh, empty(), request, RATES), 'pending');
  assert.equal(fresh.billing.length, 0);

  const stale = { ...request, completed_at: new Date(Date.now() - 3600_000) };
  assert.equal(await recordLanehubCharge(old, empty(), stale, RATES), 'released');
  assert.equal(old.billing[0].state, 'released');
});

// 折算汇率必须取对面的：拿配置里那个去折，实测差 4%（配 7 / 对面 6.7078），
// 而插件作者的分成就是按这个数分的。
test('补记用 lanehub 现行汇率，配置里的只兜底', async () => {
  const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 4250 }]);
  lanehub.usdRate = async () => 6.7078;
  await recordLanehubCharge(db, lanehub, request, RATES);
  assert.equal(db.billing[0].amount, quotaToCny(4250, 6.7078, 500000));

  const down = fakeDb(), broken = fakeLanehub([{ type: 2, quota: 4250 }]);
  broken.usdRate = async () => { throw new Error('lanehub down') };
  await recordLanehubCharge(down, broken, request, { ...RATES, usdCnyRate: 7 });
  assert.equal(down.billing[0].amount, quotaToCny(4250, 7, 500000), '读不到汇率时用配置值，不能停摆');
});

// lanehub 任务失败会退款，但它退款写的是**系统日志**，原来那条消费日志还在、quota 还是全额。
// 照着日志记账就会把已退款的失败任务算成收入，还给作者分了钱——用户的钱退了，账面却还在。
test('失败/取消的任务落 released，且一次日志都不查', async () => {
  for (const status of ['failed', 'cancelled']) {
    const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 4250 }]);
    const outcome = await recordLanehubCharge(db, lanehub, { ...request, task_status: status }, RATES);
    assert.equal(outcome, 'released');
    assert.equal(db.billing[0].state, 'released');
    assert.equal(db.billing[0].amount, 0, '失败的任务不能有金额，否则作者按它分成');
    assert.equal(lanehub.seen.length, 0, '不该去查消费日志——那条日志还在，查了就会记错');
  }
});

test('完成的任务照常记账（上面那条不能把正常的也挡掉）', async () => {
  const db = fakeDb(), lanehub = fakeLanehub([{ type: 2, quota: 4250 }]);
  assert.equal(await recordLanehubCharge(db, lanehub, { ...request, task_status: 'completed' }, RATES), 'settled');
  assert.equal(db.billing[0].amount, quotaToCny(4250, 7, 500000));
});

import { skillsInRequest } from '../src/earnings.mjs';

// 归属的依据是请求体里真的有 skill 内容——用户为它付了 token，这是可证实的事实，
// 不是客户端的声称。格式来自 dsh-skill 的 renderSkillContent，两条加载路径共用。
test('从请求体认出这一轮加载了哪些 skill', () => {
  const skill = (name) => `<skill_content name="${name}">\n<skill_instructions>做事</skill_instructions>\n</skill_content>`;
  assert.deepEqual(skillsInRequest({ messages: [{ role: 'user', content: '你好' }] }), [], '普通对话不该认出任何 skill');
  assert.deepEqual(skillsInRequest({
    messages: [{ role: 'user', content: '做个 PPT' }, { role: 'tool', content: [{ type: 'text', text: skill('ip-workbench-ppt') }] }],
  }), ['ip-workbench-ppt']);
  // 一轮可以加载多个，各记各的；同一个重复出现只算一次。
  assert.deepEqual(skillsInRequest({
    system: skill('punk-cover'),
    messages: [{ role: 'tool', content: skill('ip-workbench-ppt') }, { role: 'tool', content: skill('punk-cover') }],
  }).sort(), ['ip-workbench-ppt', 'punk-cover']);
  // JSON 里转义过的引号也要认得出来（请求体经过序列化的那条路）。
  assert.deepEqual(skillsInRequest({ messages: [{ content: '<skill_content name=\\"escaped-one\\">' }] }), ['escaped-one']);
  // 名字里的怪字符不收：登记表的键就是这个，别让它变成注入点。
  assert.deepEqual(skillsInRequest({ messages: [{ content: '<skill_content name="../../etc/passwd">' }] }), []);
});
