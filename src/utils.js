export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mean(values) {
  if (!values.length) return 0;
  const total = values.reduce((sum, v) => sum + v, 0);
  return total / values.length;
}

export function id(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function weightedChoice(weightedItems) {
  const total = weightedItems.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return weightedItems[0]?.value;

  let cursor = Math.random() * total;
  for (const item of weightedItems) {
    cursor -= item.weight;
    if (cursor <= 0) return item.value;
  }
  return weightedItems[weightedItems.length - 1]?.value;
}

