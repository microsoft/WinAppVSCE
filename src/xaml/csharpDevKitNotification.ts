import { DISMISS_ACTION_LABEL } from "./xamlConstants";

export const CSHARP_DEV_KIT_EXTENSION_ID = "ms-dotnettools.csdevkit";
export const CSHARP_DEV_KIT_DISMISSED_KEY = "winui-xaml.csharpDevKitRecommendationDismissed";
export const CSHARP_DEV_KIT_MARKETPLACE_URI = `vscode:extension/${CSHARP_DEV_KIT_EXTENSION_ID}`;

export const CSHARP_DEV_KIT_RECOMMENDATION = {
  message:
    "For full IntelliSense in WinUI C# code-behind files, install the C# Dev Kit extension.",
  installAction: "Install",
  dismissAction: DISMISS_ACTION_LABEL,
} as const;

/** Limits the recommendation to one eligible code-behind document per extension-host session. */
export class CsharpDevKitNotificationGate {
  private shown = false;

  shouldShow(filePath: string, isInstalled: boolean, isDismissed: boolean): boolean {
    if (
      this.shown ||
      isInstalled ||
      isDismissed ||
      !filePath.toLowerCase().endsWith(".xaml.cs")
    ) {
      return false;
    }

    this.shown = true;
    return true;
  }
}
