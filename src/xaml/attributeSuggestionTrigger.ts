/** Returns true when Enter placed the caret at an empty attribute position inside a start tag. */
export function shouldTriggerAttributeSuggestions(text: string, offset: number): boolean {
  if (offset <= 0 || offset > text.length) {
    return false;
  }

  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  if (text.slice(lineStart, offset).trim().length !== 0) {
    return false;
  }

  const lt = text.lastIndexOf("<", offset - 1);
  const gt = text.lastIndexOf(">", offset - 1);
  if (lt < 0 || gt > lt || lt + 1 >= text.length) {
    return false;
  }

  const first = text[lt + 1];
  if (first === "/" || first === "!" || first === "?") {
    return false;
  }

  let quote: "'" | '"' | undefined;
  let sawAttributeGap = false;
  for (let index = lt + 1; index < offset; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      sawAttributeGap = true;
    }
  }

  return quote === undefined && sawAttributeGap;
}

export function isEnterEdit(text: string): boolean {
  return /^\r?\n[ \t]*$/.test(text);
}
