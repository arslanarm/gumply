/**
 * Arrow-key movement in a picker made of several emoji grids stacked
 * vertically (Recent, Smileys, People, …). Each section's rows are `columns`
 * wide except its last row. Indices are global across all sections.
 */
export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function moveInGrid(
  sectionSizes: readonly number[],
  columns: number,
  index: number,
  key: GridKey,
): number {
  const total = sectionSizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return -1;
  if (index < 0 || index >= total) return key === "End" || key === "ArrowUp" ? total - 1 : 0;

  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(total - 1, index + 1);

  // Locate the section, row and column of `index`.
  const starts: number[] = [];
  let start = 0;
  for (const size of sectionSizes) {
    starts.push(start);
    start += size;
  }
  let section = 0;
  while (section < sectionSizes.length - 1 && index >= starts[section + 1]!) section += 1;
  const offset = index - starts[section]!;
  const row = Math.floor(offset / columns);
  const col = offset % columns;
  const rows = (size: number) => Math.ceil(size / columns);

  if (key === "ArrowDown") {
    if (row + 1 < rows(sectionSizes[section]!)) {
      return starts[section]! + Math.min((row + 1) * columns + col, sectionSizes[section]! - 1);
    }
    let next = section + 1;
    while (next < sectionSizes.length && sectionSizes[next] === 0) next += 1;
    if (next >= sectionSizes.length) return index;
    return starts[next]! + Math.min(col, sectionSizes[next]! - 1);
  }

  // ArrowUp
  if (row > 0) return starts[section]! + (row - 1) * columns + col;
  let prev = section - 1;
  while (prev >= 0 && sectionSizes[prev] === 0) prev -= 1;
  if (prev < 0) return index;
  const size = sectionSizes[prev]!;
  const lastRow = rows(size) - 1;
  return starts[prev]! + Math.min(lastRow * columns + col, size - 1);
}
