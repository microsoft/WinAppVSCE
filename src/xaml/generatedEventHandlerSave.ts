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
