/**
 * A widget's lists as an indented outline, read from the markup a screen reader sees: each list
 * item's label, `#` before a Todo Group, two spaces per level of nesting.
 */
export function outline(root: HTMLElement): string[] {
  const lines: string[] = [];
  const walk = (list: Element, depth: number) => {
    for (const item of Array.from(list.children)) {
      const label = document.getElementById(item.getAttribute("aria-labelledby") ?? "");
      const isGroup = label !== null && /^H[3-6]$/.test(label.tagName);
      lines.push(`${"  ".repeat(depth)}${isGroup ? "# " : ""}${label?.textContent ?? ""}`);
      const nested = item.querySelector(":scope > ul");
      if (nested) walk(nested, depth + 1);
    }
  };
  const top = root.querySelector("ul");
  if (top) walk(top, 0);
  return lines;
}
