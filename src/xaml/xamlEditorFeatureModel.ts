export const surroundElements = ["Border", "Grid", "StackPanel"] as const;

export type SurroundElement = (typeof surroundElements)[number];

export function isSurroundElement(value: unknown): value is SurroundElement {
  return (
    typeof value === "string" &&
    (surroundElements as readonly string[]).includes(value)
  );
}

export function createSurroundSnippet(element: SurroundElement): string {
  return `<${element}>\n\t\${TM_SELECTED_TEXT}\n</${element}>`;
}

export async function resolveSurroundElement(
  requestedElement: unknown,
  pickElement: () => Thenable<string | undefined>
): Promise<SurroundElement | undefined> {
  if (isSurroundElement(requestedElement)) {
    return requestedElement;
  }

  const pickedElement = await pickElement();
  return isSurroundElement(pickedElement) ? pickedElement : undefined;
}

export async function executeSurroundCommand<TSelection extends { isEmpty: boolean }>(
  requestedElement: unknown,
  languageId: string,
  selections: readonly TSelection[],
  pickElement: () => PromiseLike<string | undefined>,
  insertSnippet: (
    snippet: string,
    selections: readonly TSelection[]
  ) => PromiseLike<unknown>
): Promise<boolean> {
  const nonEmptySelections = selections.filter((selection) => !selection.isEmpty);
  if (languageId !== "xaml" || nonEmptySelections.length === 0) {
    return false;
  }

  const element = await resolveSurroundElement(requestedElement, pickElement);
  if (!element) {
    return false;
  }

  await insertSnippet(createSurroundSnippet(element), nonEmptySelections);
  return true;
}
