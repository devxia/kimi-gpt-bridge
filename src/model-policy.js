export const EFFORT_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function parseModelAndEffort(rawModel) {
  const raw = String(rawModel ?? '');
  for (const suffix of EFFORT_SUFFIXES) {
    if (raw.endsWith(`-${suffix}`)) {
      return { model: raw.slice(0, -(suffix.length + 1)), effort: suffix };
    }
  }
  return { model: raw, effort: undefined };
}

export function isRetiredModel(model) {
  return parseModelAndEffort(model).model === 'gpt-5.4-mini';
}

export function defaultEffortForModel(model, fallback) {
  return model === 'gpt-6-astra' ? 'medium' : fallback;
}

export function applyCatalogModelPolicy(model) {
  return {
    ...model,
    defaultEffort: defaultEffortForModel(model.slug, model.defaultEffort),
    ...(model.slug === 'gpt-5.5' ? { displayName: 'GPT-5.5 (Legacy)' } : {}),
    ...(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].includes(model.slug)
      ? { description: model.description ? `Older: ${model.description}` : 'Older' }
      : {}),
  };
}
