"""Configure Tencent SES interactively on the server. Credentials are never printed."""
import getpass
import json
import os
import re
import tempfile
from pathlib import Path

sender = input('Verified sender address (for example noreply@mail.ipzsk.com): ').strip()
region = input('SES region [ap-hongkong]: ').strip() or 'ap-hongkong'
template_id = int(input('Approved template ID: ').strip())
secret_id = getpass.getpass('CAM SecretId (hidden): ').strip()
secret_key = getpass.getpass('CAM SecretKey (hidden): ').strip()
if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', sender):
    raise SystemExit('Invalid sender address')
if region not in ('ap-hongkong', 'ap-guangzhou') or template_id <= 0:
    raise SystemExit('Invalid region or template ID')
if not re.fullmatch(r'AKID[A-Za-z0-9]{10,100}', secret_id) or not 16 <= len(secret_key) <= 256:
    raise SystemExit('Invalid credential format')
folder = Path(__file__).resolve().parent.parent / 'secrets' / 'mail'
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(mode='w', dir=folder, delete=False) as output:
    temporary = Path(output.name)
    os.chmod(temporary, 0o600)
    json.dump({'from': sender, 'region': region, 'templateId': template_id,
               'secretId': secret_id, 'secretKey': secret_key}, output)
try:
    temporary.replace(folder / 'tencent-ses.json')
finally:
    if temporary.exists():
        temporary.unlink()
print('Mail configuration saved privately. Restart the gateway to activate it.')
