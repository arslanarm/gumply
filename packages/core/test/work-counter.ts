/**
 * A work counter for growth tests (#9j9cd5x4): how much a call does, counted
 * instead of timed, so a test can't fail because the machine is busy.
 *
 * One unit per Map/Set get, set, has and add; every element an array search or
 * callback method passes over (`filter`, `some`, `find`, `includes`, `indexOf`,
 * `forEach`, `map`, `reduce`…); and every comparison `sort` makes. Code that
 * scans or compares everything with everything shows up here as it would on
 * the clock. Plain `for` loops aren't counted, so tests should compare sizes
 * (8x the input → about 8x the work), not exact totals.
 */
export function countWork(run: () => void): number {
  let units = 0;
  const patches: Array<[object, string, unknown]> = [];
  const patch = (proto: object, name: string, wrap: (original: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown) => {
    const target = proto as Record<string, unknown>;
    const original = target[name] as (...args: unknown[]) => unknown;
    patches.push([proto, name, original]);
    target[name] = wrap(original);
  };
  const perCall = (original: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      units += 1;
      return original.apply(this, args);
    };
  const perElement = (original: (...args: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      units += (this as unknown[]).length;
      return original.apply(this, args);
    };
  for (const name of ["get", "set", "has"]) patch(Map.prototype, name, perCall);
  for (const name of ["add", "has"]) patch(Set.prototype, name, perCall);
  for (const name of ["filter", "some", "every", "find", "findIndex", "includes", "indexOf", "forEach", "map", "reduce"]) {
    patch(Array.prototype, name, perElement);
  }
  patch(Array.prototype, "sort", (original) =>
    function (this: unknown, ...args: unknown[]) {
      const compare = args[0] as ((a: unknown, b: unknown) => number) | undefined;
      // A sort without a comparator keeps the engine's own order (code units, undefined last): it is
      // called unchanged and counted as one pass. Never change what the code under test does.
      if (typeof compare !== "function") {
        units += (this as unknown[]).length;
        return original.apply(this, args);
      }
      return original.call(this, (a: unknown, b: unknown) => {
        units += 1;
        return compare(a, b);
      });
    },
  );
  try {
    run();
  } finally {
    for (const [proto, name, original] of patches.reverse()) (proto as Record<string, unknown>)[name] = original;
  }
  return units;
}
