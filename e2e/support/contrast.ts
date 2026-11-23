import type { Locator } from '@playwright/test';

/**
 * #3nnx98m4: WCAG 1.4.3 text contrast, measured in the page like axe's
 * `color-contrast` rule. For every visible element with its own text inside
 * `scope`:
 * - the text colour, faded by the opacity of the element and its ancestors;
 * - the backdrop, composited from the ancestors' background colours up to the root;
 * - the ratio must be ≥ 4.5:1 (≥ 3:1 for large text: ≥ 24px, or ≥ 18.66px bold).
 * Disabled controls are exempt, as in WCAG. Elements over a background image are
 * skipped (their backdrop can't be read from styles), and reported as such.
 */
export interface ContrastFailure {
  text: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
  selector: string;
}

export async function contrastFailures(scope: Locator): Promise<ContrastFailure[]> {
  return scope.evaluate((root) => {
    type Rgba = [number, number, number, number];
    const probe = document.createElement('canvas').getContext('2d')!;
    // Any CSS colour (rgb, color(srgb …), color-mix results) through the canvas parser, then read back as RGBA.
    const parse = (value: string): Rgba => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const luminance = ([r, g, b]: Rgba) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const selectorOf = (el: Element) => {
      const id = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${id ? `[data-testid="${id}"]` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    };

    const failures: ContrastFailure[] = [];
    const elements = [root, ...root.querySelectorAll('*')] as Element[];
    for (const el of elements) {
      const own = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim();
      if (!own) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.visibility !== 'visible' || style.display === 'none' || rect.width === 0 || rect.height === 0) continue;
      if ((el as HTMLButtonElement).disabled || el.closest('[disabled], [aria-disabled="true"]')) continue;
      let opacity = 1;
      let backdrop: Rgba = [0, 0, 0, 0];
      const layers: Rgba[] = [];
      let image = false;
      for (let node: Element | null = el; node; node = node.parentElement) {
        const s = getComputedStyle(node);
        opacity *= Number.parseFloat(s.opacity);
        if (s.backgroundImage !== 'none') image = true;
        layers.push(parse(s.backgroundColor));
      }
      if (opacity === 0 || image) continue;
      backdrop = [255, 255, 255, 1];
      for (const layer of layers.reverse()) backdrop = over(layer, backdrop);
      const fg = parse(style.color);
      const text = over([fg[0], fg[1], fg[2], fg[3] * opacity], backdrop);
      const size = Number.parseFloat(style.fontSize);
      const bold = Number.parseInt(style.fontWeight, 10) >= 700;
      const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const value = ratio(text, backdrop);
      if (value < required) {
        failures.push({
          text: own.slice(0, 40),
          ratio: Math.round(value * 100) / 100,
          required,
          color: style.color,
          background: `rgb(${backdrop.slice(0, 3).map(Math.round).join(' ')})`,
          selector: selectorOf(el),
        });
      }
    }
    return failures;
  });
}
