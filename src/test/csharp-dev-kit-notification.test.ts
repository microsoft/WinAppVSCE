import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSHARP_DEV_KIT_DISMISSED_KEY,
  CSHARP_DEV_KIT_EXTENSION_ID,
  CSHARP_DEV_KIT_MARKETPLACE_URI,
  CSHARP_DEV_KIT_RECOMMENDATION,
  CsharpDevKitNotificationGate,
} from "../xaml/csharpDevKitNotification";

describe("CsharpDevKitNotificationGate", () => {
  it("shows once for a XAML C# code-behind file when Dev Kit is absent", () => {
    const gate = new CsharpDevKitNotificationGate();

    assert.equal(gate.shouldShow("C:\\app\\MainWindow.xaml.cs", false, false), true);
    assert.equal(gate.shouldShow("C:\\app\\Page.xaml.cs", false, false), false);
  });

  it("matches code-behind paths case-insensitively", () => {
    const gate = new CsharpDevKitNotificationGate();
    assert.equal(gate.shouldShow("C:\\app\\MainWindow.XAML.CS", false, false), true);
  });

  it("does not show for other C# files", () => {
    const gate = new CsharpDevKitNotificationGate();
    assert.equal(gate.shouldShow("C:\\app\\ViewModel.cs", false, false), false);
    assert.equal(gate.shouldShow("C:\\app\\NotXaml.cs", false, false), false);
  });

  it("does not show when Dev Kit is installed or the recommendation is dismissed", () => {
    assert.equal(
      new CsharpDevKitNotificationGate().shouldShow("C:\\app\\Page.xaml.cs", true, false),
      false
    );
    assert.equal(
      new CsharpDevKitNotificationGate().shouldShow("C:\\app\\Page.xaml.cs", false, true),
      false
    );
  });

  it("exposes the expected message, actions, extension, and persistence key", () => {
    assert.equal(CSHARP_DEV_KIT_EXTENSION_ID, "ms-dotnettools.csdevkit");
    assert.equal(
      CSHARP_DEV_KIT_MARKETPLACE_URI,
      "vscode:extension/ms-dotnettools.csdevkit"
    );
    assert.match(CSHARP_DEV_KIT_RECOMMENDATION.message, /full IntelliSense/i);
    assert.deepEqual(
      [
        CSHARP_DEV_KIT_RECOMMENDATION.installAction,
        CSHARP_DEV_KIT_RECOMMENDATION.dismissAction,
      ],
      ["Install", "Don't Show Again"]
    );
    assert.equal(
      CSHARP_DEV_KIT_DISMISSED_KEY,
      "winui-xaml.csharpDevKitRecommendationDismissed"
    );
  });
});
