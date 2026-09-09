import { XAML_COMMANDS } from "./xamlConstants";

export interface SaveableGeneratedHandlerDocument {
  readonly isDirty: boolean;
  save(): Thenable<boolean>;
}

export interface GeneratedHandlerCommand {
  readonly command: string;
  readonly arguments?: readonly unknown[];
}

export function targetsDirtyGeneratedHandlerDocument(
  command: GeneratedHandlerCommand | undefined,
  isDirty: (documentUri: string) => boolean,
): boolean {
  if (command?.command !== XAML_COMMANDS.saveGeneratedEventHandler) {
    return false;
  }

  const documentUri = command.arguments?.[0];
  return typeof documentUri === "string" && isDirty(documentUri);
}

export async function saveGeneratedEventHandlerDocument(
  document: SaveableGeneratedHandlerDocument,
  displayPath: string,
  confirmSave: (message: string, action: string) => Thenable<boolean>,
): Promise<void> {
  if (!document.isDirty) {
    return;
  }

  const action = "Save File";
  const confirmed = await confirmSave(
    `Save changes to ${displayPath} so XAML IntelliSense can load the generated handler? This saves all pending edits in that file.`,
    action,
  );
  if (!confirmed) {
    return;
  }

  if (!(await document.save())) {
    throw new Error(`Could not save generated event handler in ${displayPath}.`);
  }
}

export const GENERATED_HANDLER_SAVED_MESSAGE =
  "Code-behind changes were saved. Retry Generate Event Handler.";
export const GENERATED_HANDLER_CHANGED_MESSAGE =
  "The code-behind changed. Retry Generate Event Handler.";

/** The open code-behind document at the moment the edit is about to be applied. */
export interface GeneratedHandlerTargetState {
  readonly isDirty: boolean;
  readonly version: number | undefined;
}

/** The VS Code surfaces the apply flow drives, injected so the flow is testable without a host. */
export interface ApplyGeneratedHandlerHost<TEdit> {
  /** The live state of the code-behind, or undefined when it is not open in an editor. */
  getTarget(documentUri: string): GeneratedHandlerTargetState | undefined;
  applyEdit(edit: TEdit): Thenable<boolean>;
  runCommand(command: string, documentUri: string): Thenable<unknown>;
  showInformationMessage(message: string): void;
}

/**
 * Applies a server-generated handler stub, but only against the exact code-behind the server read.
 * The server computes offsets from the file on disk, so an unsaved or newer buffer would place the
 * stub in the wrong spot: those cases save or report instead of applying a stale edit.
 */
export async function applyGeneratedEventHandlerEdit<TEdit>(
  documentUri: string,
  edit: TEdit,
  originalCommand: GeneratedHandlerCommand,
  wasDirty: boolean,
  originalVersion: number | undefined,
  host: ApplyGeneratedHandlerHost<TEdit>,
): Promise<void> {
  const target = host.getTarget(documentUri);
  if (wasDirty || target?.isDirty) {
    if (target?.isDirty) {
      await host.runCommand(originalCommand.command, documentUri);
    }
    // Re-read: the save above may have cleared the dirty flag, in which case the user can retry.
    if (!host.getTarget(documentUri)?.isDirty) {
      host.showInformationMessage(GENERATED_HANDLER_SAVED_MESSAGE);
    }
    return;
  }

  if (
    target &&
    originalVersion !== undefined &&
    target.version !== originalVersion
  ) {
    host.showInformationMessage(GENERATED_HANDLER_CHANGED_MESSAGE);
    return;
  }

  if (!(await host.applyEdit(edit))) {
    throw new Error("Could not apply the generated event handler edit.");
  }

  await host.runCommand(originalCommand.command, documentUri);
}
