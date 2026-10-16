export function outputTerminals(index: number) {
  return index < 4 ? `${37 - index * 3} COM / ${36 - index * 3} NO / ${38 - index * 3} NC`
    : `${26 - (index - 4) * 2}、${25 - (index - 4) * 2} · 常开触点两端`
}
