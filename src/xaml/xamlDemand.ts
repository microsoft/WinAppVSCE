export function hasOpenXamlDocument(
  documents: Iterable<{ languageId: string }>
): boolean {
  for (const document of documents) {
    if (document.languageId === "xaml") {
      return true;
    }
  }
  return false;
}
