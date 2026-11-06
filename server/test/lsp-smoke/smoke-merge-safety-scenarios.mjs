import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export async function runMergeSafetyScenarios(ctx) {
  const { send, waitFor, responseFor, xamlUri, xamlText, XAML, NS, nextVersion,
    offsetToPosition, hoverAt, codeActionAtCaret, projectContextStatuses } = ctx;
  let id = 95000;
  const request = async (method, uri, extra = {}) => {
    send({ id: ++id, method: `textDocument/${method}`, params: { textDocument: { uri }, ...extra } });
    return waitFor(responseFor(id), 30000, `merge safety ${method}`);
  };
  const open = (uri, text) => send({
    method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "xaml", version: 1, text } },
  });
  const change = (uri, text, version = nextVersion()) => send({
    method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] },
  });
  const close = uri => send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  const watched = path => send({
    method: "workspace/didChangeWatchedFiles", params: { changes: [{ uri: pathToFileURL(path).href, type: 2 }] },
  });
  const status = (uri, state) => message =>
    message.method === "winui-xaml/projectContextStatus" && message.params?.uri === uri && message.params?.state === state;

  const renameRoot = join(ctx.buildRequiredRoot, "DelayedRename");
  mkdirSync(renameRoot);
  const fixtureProject = readFileSync(join(dirname(XAML), "SmokeFixture.csproj"), "utf8");
  const framework = fixtureProject.match(/<TargetFramework>([^<]+)<\/TargetFramework>/)?.[1];
  const sdkVersion = fixtureProject.match(/Include="Microsoft.WindowsAppSDK"\s+Version="([^"]+)"/)?.[1];
  assert.ok(framework && sdkVersion, "rename regression needs the fixture's framework and Windows App SDK version");
  const renameProject = join(renameRoot, "DelayedRename.csproj");
  writeFileSync(renameProject, `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><TargetFramework>${framework}</TargetFramework><UseWinUI>true</UseWinUI><WinUISDKReferences>false</WinUISDKReferences></PropertyGroup>
    <ItemGroup><PackageReference Include="Microsoft.WindowsAppSDK" Version="${sdkVersion}"/></ItemGroup>
    <Target Name="WaitForRenameProbe" BeforeTargets="CoreCompile">
      <Exec Command="powershell.exe -NoProfile -NonInteractive -File &quot;$(MSBuildProjectDirectory)\\WaitForRename.ps1&quot;"/>
    </Target>
  </Project>`);
  writeFileSync(join(renameRoot, "WaitForRename.ps1"), `
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'continue-load'))) {
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Rename regression did not release project loading' }
      Start-Sleep -Milliseconds 50
    }`);
  writeFileSync(join(renameRoot, "Page.cs"), `namespace RenameProbe;
    public partial class Page : Microsoft.UI.Xaml.Controls.Page {
      public string Read() => Input.Text;
    }`);
  const renameText = `<Page ${NS} x:Class="RenameProbe.Page">
    <Page.Resources><SolidColorBrush x:Key="Accent" Color="Red"/><SolidColorBrush x:Key="ExistingAccent" Color="Blue"/></Page.Resources>
    <StackPanel><TextBox x:Name="Input"/><TextBox x:Name="Unused"/><Border Background="{StaticResource Accent}"/></StackPanel>
  </Page>`;
  const renamePath = join(renameRoot, "Page.xaml");
  writeFileSync(renamePath, renameText);
  execFileSync("dotnet", ["restore", renameProject, "--nologo"], {
    stdio: "pipe", timeout: 90000, windowsHide: true,
  });
  const renameUri = pathToFileURL(renamePath).href;
  const frameworkReady = waitFor(status(renameUri, "framework-ready"), 90000, "rename framework context");
  const fullReady = waitFor(status(renameUri, "ready"), 120000, "rename full context");
  const inputPosition = offsetToPosition(renameText, renameText.indexOf('Name="Input"') + 8);
  const unusedPosition = offsetToPosition(renameText, renameText.indexOf('Name="Unused"') + 8);
  open(renameUri, renameText);
  try {
    try {
      await frameworkReady;
      for (const method of ["prepareRename", "rename"]) {
        const response = await request(method, renameUri, { position: inputPosition, newName: "Entry" });
        assert.equal(response.error?.code, -32803, `${method} must refuse a framework-only name rename`);
        assert.match(response.error.message, /fully resolved project/);
        assert.equal(response.result, undefined);
      }
    } finally {
      writeFileSync(join(renameRoot, "continue-load"), "");
    }
    await fullReady;
    for (const method of ["prepareRename", "rename"]) {
      const blocked = await request(method, renameUri, { position: inputPosition, newName: "Entry" });
      assert.equal(blocked.error?.code, -32803, `${method} must retain code-behind safety after loading`);
      assert.match(blocked.error.message, /code-behind references/);
      const safe = await request(method, renameUri, { position: unusedPosition, newName: "Spare" });
      assert.equal(safe.error, undefined);
      if (method === "prepareRename") assert.equal(safe.result?.placeholder, "Unused");
      else assert.equal(safe.result?.changes?.[renameUri]?.length, 1);
    }
    for (const newName of ["Brand,Accent", "Brand=Accent"]) {
      for (const offset of [renameText.indexOf("Accent"), renameText.lastIndexOf("Accent")]) {
        const response = await request("rename", renameUri, {
          position: offsetToPosition(renameText, offset + 2), newName,
        });
        assert.equal(response.error?.code, -32803, "resource rename must reject markup argument delimiters");
        assert.match(response.error.message, /resource key cannot contain/);
        assert.equal(response.result, undefined);
      }
    }
    for (const newName of ["Input", "class"]) {
      const response = await request("rename", renameUri, { position: unusedPosition, newName });
      assert.equal(response.error?.code, -32803, "collisions and C# keywords must be rejected");
      assert.equal(response.result, undefined);
    }
    const unicode = await request("rename", renameUri, { position: unusedPosition, newName: "\u540d\u524d" });
    assert.equal(unicode.error, undefined);
    assert.equal(unicode.result.changes[renameUri][0].newText, "\u540d\u524d");
    for (const offset of [renameText.indexOf('"Accent"'), renameText.lastIndexOf("Accent}")]) {
      const response = await request("rename", renameUri, {
        position: offsetToPosition(renameText, offset + 2), newName: "ExistingAccent",
      });
      assert.equal(response.error?.code, -32803, "resource keys must be unique in the declaration dictionary");
      assert.equal(response.result, undefined);
    }
  } finally {
    close(renameUri);
  }
  console.log("[ok] prepare/direct name rename refuse framework-only contexts; full contexts retain safe rename and code-behind guards");
  console.log("[ok] resource rename rejects commas and equals signs from both declarations and usages without partial edits");

  const deepUri = "untitled:DeepMarkup.xaml";
  const deepText = `<Grid Tag="${"{Binding Converter=".repeat(50000)}value${"}".repeat(50000)}"/>`;
  const depthDiagnostic = waitFor(message =>
    message.method === "textDocument/publishDiagnostics" && message.params?.uri === deepUri &&
    message.params.diagnostics.some(diagnostic => diagnostic.code === "XAML0010"), 30000, "bounded markup diagnostic");
  open(deepUri, deepText);
  await depthDiagnostic;
  const symbols = await request("documentSymbol", deepUri);
  assert.ok(!symbols.error && symbols.result?.length, "server must survive 50,000 nested extensions");
  change(deepUri, "<Grid></", 2);
  const recovery = await request("completion", deepUri, { position: { line: 0, character: 8 } });
  assert.ok(recovery.result?.items?.some(item => item.textEdit?.newText === "Grid>"));
  close(deepUri);
  console.log("[ok] 50,000 nested extensions produce a diagnostic; server remains responsive and recovers");

  for (const kind of ["Cpp", "Loose", "ColdWinUI"]) {
    const folder = join(ctx.buildRequiredRoot, `ClosingTag${kind}`);
    mkdirSync(folder);
    if (kind === "Cpp") writeFileSync(join(folder, "Example.vcxproj"), "<Project/>");
    if (kind === "ColdWinUI") writeFileSync(join(folder, "Example.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net10.0-windows10.0.26100.0</TargetFramework><UseWinUI>true</UseWinUI></PropertyGroup>
      <ItemGroup><PackageReference Include="Microsoft.WindowsAppSDK" Version="2.2.0"/></ItemGroup></Project>`);
    const path = join(folder, "Page.xaml");
    writeFileSync(path, "<Grid></>");
    const uri = pathToFileURL(path).href;
    open(uri, "<Grid></>");
    const completion = await request("completion", uri, { position: { line: 0, character: 8 } });
    const item = completion.result?.items?.find(candidate => candidate.textEdit?.newText === "Grid");
    assert.ok(!completion.error && item, `${kind}: closing completion before semantic initialization`);
    assert.deepEqual(item.textEdit.range, { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } });
    close(uri);
  }
  console.log("[ok] C++, loose, untitled and cold WinUI closing tags work without semantic metadata");

  const appPath = join(dirname(XAML), "App.xaml");
  const appUri = pathToFileURL(appPath).href;
  const appText = readFileSync(appPath, "utf8");
  const localUri = pathToFileURL(join(dirname(XAML), "MergedResources.xaml")).href;
  const appReady = waitFor(status(appUri, "ready"), 90000, "App resource context");
  open(appUri, appText);
  await appReady;
  open(localUri, `<ResourceDictionary ${NS}><SolidColorBrush x:Key="SmokeAccentBrush" Color="Red"/></ResourceDictionary>`);
  try {
    for (const source of ["MergedResources.xaml", "RootSourceProxy.xaml"]) {
      const page = `<Page ${NS} x:Class="SmokeFixture.SmokePage">
        <Page.Resources><ResourceDictionary><ResourceDictionary.MergedDictionaries>
          <ResourceDictionary Source="${source}"/>
        </ResourceDictionary.MergedDictionaries></ResourceDictionary></Page.Resources>
        <Border Background="{StaticResource SmokeAccentBrush}"/></Page>`;
      change(xamlUri, page);
      for (const [uri, text] of [[appUri, appText], [xamlUri, page]]) {
        for (const method of ["prepareRename", "rename"]) {
          const response = await request(method, uri, {
            position: offsetToPosition(text, text.lastIndexOf("SmokeAccentBrush") + 2), newName: "BrandBrush",
          });
          assert.equal(response.error?.code, -32803, `${source} ${method}: ambiguous rename must fail`);
          assert.match(response.error.message, /external resource dictionary/);
          assert.equal(response.result, undefined, "refusal must not contain partial edits");
        }
      }
    }
    const localPage = `<Page ${NS} x:Class="SmokeFixture.SmokePage"><Page.Resources>
      <SolidColorBrush x:Key="SmokeAccentBrush" Color="Green"/></Page.Resources>
      <Border Background="{StaticResource SmokeAccentBrush}"/></Page>`;
    change(xamlUri, localPage);
    const localRename = await request("rename", xamlUri, {
      position: offsetToPosition(localPage, localPage.lastIndexOf("SmokeAccentBrush") + 2), newName: "LocalBrush",
    });
    assert.equal(localRename.error, undefined);
    assert.equal(localRename.result?.changes?.[xamlUri]?.length, 2, "unambiguous local declaration and usage still rename");
    assert.equal(Object.keys(localRename.result.changes).length, 1, "local rename must not touch App");
  } finally {
    close(localUri);
    close(appUri);
    change(xamlUri, xamlText);
  }
  console.log("[ok] App and usage renames refuse ambiguous external Sources, including unsaved buffers; local rename retained");

  // Earlier scenarios add project inputs. Settle that change before checking unchanged saves.
  const settledInputs = waitFor(status(xamlUri, "ready"), 90000, "settled inputs before ordinary saves");
  watched(join(dirname(XAML), "SmokeFixture.csproj"));
  await settledInputs;
  const hoverBody = xamlText.replace("<Button", "<But|ton");
  assert.notEqual(hoverBody, xamlText);
  const deadline = Date.now() + 30000;
  let hover = "";
  while (Date.now() < deadline) {
    hover = await hoverAt(++id, hoverBody, "ready before ordinary save");
    if (hover.includes("Button")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(hover, /Button/, "fixture must be semantically ready before save");
  const statusStart = projectContextStatuses.length;
  for (let save = 0; save < 3; save++) {
    watched(XAML);
    send({ method: "textDocument/didSave", params: { textDocument: { uri: xamlUri } } });
    assert.match(await hoverAt(++id, hoverBody, "immediate hover after ordinary save"), /Button/);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(projectContextStatuses.slice(statusStart).some(entry =>
    entry.uri === xamlUri && ["loading", "framework-ready", "ready"].includes(entry.state)), false,
  `ordinary unchanged-class XAML saves must not restart the context: ${JSON.stringify(projectContextStatuses.slice(statusStart))}`);
  console.log("[ok] three ordinary XAML saves preserve immediate semantic hover without project reloads");

  const original = readFileSync(XAML, "utf8");
  const changedClass = original.replace('x:Class="SmokeFixture.SmokePage"', 'x:Class="SmokeFixture.SavedClassProbe"');
  assert.notEqual(changedClass, original);
  const restore = () => writeFileSync(XAML, original);
  process.once("exit", restore);
  try {
    const loading = waitFor(status(xamlUri, "loading"), 30000, "saved x:Class reload");
    const ready = waitFor(status(xamlUri, "ready"), 90000, "saved x:Class ready");
    writeFileSync(XAML, changedClass);
    watched(XAML);
    await loading;
    await ready;
  } finally {
    restore();
    process.removeListener("exit", restore);
    watched(XAML);
  }
  assert.match(await hoverAt(++id, hoverBody, "restored x:Class hover"), /Button/);
  console.log("[ok] changing saved x:Class still reloads and restores the project context");

  const codePath = join(dirname(XAML), "SmokePage.xaml.cs");
  const codeOriginal = readFileSync(codePath, "utf8");
  const projectPath = join(dirname(XAML), "SmokeFixture.csproj");
  const restoreInputs = () => {
    writeFileSync(codePath, codeOriginal);
    writeFileSync(projectPath, fixtureProject);
  };
  process.once("exit", restoreInputs);
  try {
    for (const [member, reopen] of [["FreshAfterSave", false], ["FreshAfterReopen", true]]) {
      writeFileSync(codePath, codeOriginal +
        `\npublic sealed partial class SmokePage { public string ${member} => "fresh"; }\n`);
      const probe = `<Page ${NS} x:Class="SmokeFixture.SmokePage"><TextBlock Text="{x:Bind Fresh}"/></Page>`;
      if (reopen) {
        close(xamlUri);
        open(xamlUri, probe);
      } else {
        change(xamlUri, probe);
        send({ method: "textDocument/didSave", params: { textDocument: { uri: xamlUri } } });
      }
      const deadline = Date.now() + 90000;
      let labels = [];
      do {
        const result = await request("completion", xamlUri, {
          position: offsetToPosition(probe, probe.indexOf("Fresh}") + "Fresh".length),
        });
        labels = result.result?.items?.map(item => item.label) || [];
        if (labels.includes(member)) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      assert.ok(labels.includes(member), `${member}: save/reopen must detect disk changes without watcher events`);
    }
    const restoreRequired = waitFor(status(xamlUri, "packages-not-restored"), 90000, "new unrestored package");
    writeFileSync(projectPath, fixtureProject.replace("</Project>",
      '<ItemGroup><PackageReference Include="Example.Unrestored.Package" Version="1.0.0"/></ItemGroup></Project>'));
    send({ method: "textDocument/didSave", params: { textDocument: { uri: xamlUri } } });
    await restoreRequired;
  } finally {
    restoreInputs();
    process.removeListener("exit", restoreInputs);
    const recovered = waitFor(status(xamlUri, "ready"), 90000, "restored disk freshness fixture");
    watched(projectPath);
    change(xamlUri, xamlText);
    await recovered;
  }
  console.log("[ok] save/reopen detect missed C# watcher events; added unrestored packages report restore-required");

  const actions = await codeActionAtCaret(++id,
    `<Page ${NS} x:Class="SmokeFixture.SmokePage"><Button Tapped="OnSmokeTapped|"/></Page>`, "real Tapped signature");
  const generated = actions.find(action => action.title.includes("OnSmokeTapped"));
  assert.ok(generated?.edit?.changes, "actual WinUI Tapped event must offer a handler");
  const edits = Object.values(generated.edit.changes).flat();
  assert.ok(edits.some(edit => edit.newText.includes("global::Microsoft.UI.Xaml.Input.TappedRoutedEventArgs")),
    "Tapped handler must not depend on importing Microsoft.UI.Xaml.Input");
  change(xamlUri, xamlText);
  console.log("[ok] real WinUI Tapped code action emits a fully qualified event argument type");
}
