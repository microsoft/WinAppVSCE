export interface PromptedTextEditRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface PromptedTextEditRequest {
  documentUri: string;
  range: PromptedTextEditRange;
  prompt: string;
  placeHolder: string;
  initialValue: string;
  prefix: string;
  suffix: string;
  expectedVersion: number | null;
  expectedText: string;
  choices: string[];
  customChoiceLabel: string;
  validationPattern: string;
  validationMessage: string;
}

export interface GuardedTextEditRequest {
  documentUri: string;
  expectedVersion: number | null;
  edits: Array<{
    range: PromptedTextEditRange;
    expectedText: string;
    newText: string;
  }>;
}

export interface PromptedTextEditDocument {
  version: number;
  source?: unknown;
  getText(range: PromptedTextEditRange): string;
}

export interface PromptedTextEditDependencies {
  showInput(options: {
    prompt: string;
    placeHolder: string;
    value: string;
    validateInput(candidate: string): string | undefined;
  }): Promise<string | undefined>;
  showChoice(options: {
    placeHolder: string;
    choices: string[];
  }): Promise<string | null | undefined>;
  openDocument(documentUri: string): Promise<PromptedTextEditDocument>;
  applyEdit(
    document: PromptedTextEditDocument,
    range: PromptedTextEditRange,
    newText: string,
  ): Promise<boolean>;
}

export interface GuardedTextEditCommandDependencies<TDocument, TRange, TWorkspaceEdit> {
  openDocument(documentUri: string): Promise<TDocument>;
  getDocumentVersion(document: TDocument): number;
  createRange(range: PromptedTextEditRange): TRange;
  isValidRange(document: TDocument, range: TRange): boolean;
  getText(document: TDocument, range: TRange): string;
  createWorkspaceEdit(): TWorkspaceEdit;
  replace(
    edit: TWorkspaceEdit,
    document: TDocument,
    range: TRange,
    newText: string,
  ): void;
  applyEdit(edit: TWorkspaceEdit): PromiseLike<boolean>;
}

export function validatePromptedXamlValue(
  value: string,
  validationPattern: string,
  validationMessage: string,
): string | undefined {
  try {
    return new RegExp(`^(?:${validationPattern})$`, "u").test(value)
      ? undefined
      : validationMessage;
  } catch {
    return "This quick fix supplied an invalid validation rule.";
  }
}

function isValidRange(range: PromptedTextEditRange): boolean {
  const values = [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ];
  return values.every(value => Number.isSafeInteger(value) && value >= 0) &&
    (range.start.line < range.end.line ||
      range.start.line === range.end.line &&
      range.start.character <= range.end.character);
}

export const INVALID_EDIT_RANGE_MESSAGE =
  "The XAML quick fix contains an invalid edit range.";
export const DOCUMENT_CHANGED_MESSAGE =
  "The XAML document changed before the quick fix was applied. Run the quick fix again.";

/** The {@link DOCUMENT_CHANGED_MESSAGE} wording, naming the document. */
export function documentChangedMessage(documentUri: string): string {
  return `The XAML document '${documentUri}' changed before the quick fix was applied. Run the quick fix again.`;
}

export async function runPromptedTextEdit(
  request: PromptedTextEditRequest,
  dependencies: PromptedTextEditDependencies,
): Promise<void> {
  if (!isValidRange(request.range)) {
    throw new Error(INVALID_EDIT_RANGE_MESSAGE);
  }

  let value: string | undefined;
  if (request.choices.length > 0) {
    const choice = await dependencies.showChoice({
      placeHolder: request.prompt,
      choices: request.choices,
    });
    if (choice === undefined) {
      return;
    }
    if (choice !== null) {
      const validationError = validatePromptedXamlValue(
        choice.trim(),
        request.validationPattern,
        request.validationMessage,
      );
      if (validationError !== undefined) {
        throw new Error(validationError);
      }
      value = choice;
    }
  }

  value ??= await dependencies.showInput({
    prompt: request.prompt,
    placeHolder: request.placeHolder,
    value: request.initialValue,
    validateInput: candidate =>
      request.initialValue.length > 0 &&
      candidate.trim() === request.initialValue
        ? "Enter a different value to resolve the diagnostic."
        : validatePromptedXamlValue(
            candidate.trim(),
            request.validationPattern,
            request.validationMessage,
          ),
  });
  if (value === undefined) {
    return;
  }

  const document = await dependencies.openDocument(request.documentUri);
  if (request.expectedVersion !== null &&
      document.version !== request.expectedVersion ||
      document.getText(request.range) !== request.expectedText) {
    throw new Error(DOCUMENT_CHANGED_MESSAGE);
  }

  const newText = `${request.prefix}${value.trim()}${request.suffix}`;
  // The prompt and document read above have already completed, so this mirrors the
  // guard at the top of the apply step; the live re-read that actually protects the
  // file happens inside the applyEdit dependency.
  if (request.expectedVersion !== null &&
      document.version !== request.expectedVersion ||
      document.getText(request.range) !== request.expectedText) {
    throw new Error(DOCUMENT_CHANGED_MESSAGE);
  }

  if (!(await dependencies.applyEdit(document, request.range, newText))) {
    throw new Error(
      `Could not edit '${request.documentUri}'. Verify that the file is writable, then run the quick fix again.`,
    );
  }
}

export async function runGuardedTextEditCommand<TDocument, TRange, TWorkspaceEdit>(
  request: GuardedTextEditRequest,
  dependencies: GuardedTextEditCommandDependencies<TDocument, TRange, TWorkspaceEdit>,
): Promise<void> {
  if (request.edits.some(edit => !isValidRange(edit.range))) {
    throw new Error(INVALID_EDIT_RANGE_MESSAGE);
  }

  const document = await dependencies.openDocument(request.documentUri);
  if (request.expectedVersion !== null &&
      dependencies.getDocumentVersion(document) !== request.expectedVersion) {
    throw new Error(
      documentChangedMessage(request.documentUri),
    );
  }

  const workspaceEdit = dependencies.createWorkspaceEdit();
  for (const edit of request.edits) {
    const range = dependencies.createRange(edit.range);
    if (!dependencies.isValidRange(document, range)) {
      throw new Error(INVALID_EDIT_RANGE_MESSAGE);
    }
    if (dependencies.getText(document, range) !== edit.expectedText) {
      throw new Error(
        documentChangedMessage(request.documentUri),
      );
    }
    dependencies.replace(workspaceEdit, document, range, edit.newText);
  }

  if (!(await dependencies.applyEdit(workspaceEdit))) {
    throw new Error(
      `Could not edit '${request.documentUri}'. Verify that the file is writable, then run the quick fix again.`,
    );
  }
}
