// Reference-image capability per model. lanehub's catalog declares which fields a model accepts but not
// how many images, so the counts live here. First match wins; unknown models take no references.
const TABLE = [
  { pattern: /^gpt-image-2(?:\.5-[a-z0-9-]+)?$/, maxImages: 15 },
];

export function referencesFor(modelId) {
  const row = TABLE.find(r => r.pattern.test(modelId));
  return { maxImages: row?.maxImages ?? 0, ...(row?.firstFrame ? { firstFrame: true } : {}), ...(row?.lastFrame ? { lastFrame: true } : {}) };
}
