import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function runEligibilityScenarios({
  root, send, waitFor, responseFor, fail, statuses, restoreNotifications, buildNotifications,
  fixtureProject, fixtureUri,
}) {
  const cases = [
    { name: "WPF", sdk: "Microsoft.NET.Sdk", properties: "<UseWPF>true</UseWPF>", package: "" },
    { name: "MAUI", sdk: "Microsoft.NET.Sdk", properties: "<UseMaui>true</UseMaui>", package: "Microsoft.Maui.Controls" },
    { name: "Uno", sdk: "Uno.Sdk/99.0.0", properties: "<UseWinUI>true</UseWinUI>", package: "Microsoft.WindowsAppSDK" },
    { name: "Unknown", sdk: "Unknown.Xaml.Sdk/99.0.0", properties: "<UseWinUI>true</UseWinUI>", package: "Microsoft.WindowsAppSDK" },
    { name: "Lookalike", sdk: "Microsoft.NET.Sdk", properties: "<UseWinUI>true</UseWinUI>", package: "Uno.WinUI" },
    { name: "ReferenceOnly", sdk: "Microsoft.NET.Sdk", properties: "", package: "Microsoft.WindowsAppSDK" },
  ];
  let id = 93000;
  for (const sample of cases) {
    const folder = join(root, `Eligibility${sample.name}`);
    mkdirSync(folder);
    const project = join(folder, "Example.csproj");
    const marker = join(folder, "unexpected-build.txt");
    writeFileSync(project, `<Project Sdk="${sample.sdk}">
      <PropertyGroup><TargetFramework>net10.0-windows</TargetFramework>${sample.properties}</PropertyGroup>
      <ItemGroup>${sample.package ? `<PackageReference Include="${sample.package}" Version="99.0.0"/>` : ""}</ItemGroup>
      <Target Name="UnexpectedBuild" BeforeTargets="Restore;ResolveReferences;CoreCompile">
        <WriteLinesToFile File="${marker}" Lines="unexpected" />
      </Target>
    </Project>`);
    writeFileSync(join(folder, "Button.cs"), "namespace Microsoft.UI.Xaml.Controls; public class Button { public string Content { get; set; } }");
    const file = join(folder, "Page.xaml");
    const text = '<Button xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Content="hello"/>';
    writeFileSync(file, text);
    const uri = pathToFileURL(file).href;
    const unsupported = waitFor(
      message => message.method === "winui-xaml/projectContextStatus" &&
        message.params?.uri === uri && message.params?.state === "winui-required",
      30000, `${sample.name} eligibility`);
    send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "xaml", version: 1, text } } });
    const status = await unsupported;
    if (status.params.message !== "Not supported for this project. Only WinUI 3 projects are supported at this time.") {
      fail(`${sample.name}: missing support explanation`);
    }
    send({ id: ++id, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 0, character: 3 } } });
    const hover = await waitFor(responseFor(id), 10000, `${sample.name} hover`);
    if (hover.error || hover.result !== null) fail(`${sample.name}: unconfirmed project exposed type information`);
    send({ id: ++id, method: "textDocument/documentSymbol", params: { textDocument: { uri } } });
    const outline = await waitFor(responseFor(id), 10000, `${sample.name} outline`);
    if (outline.error || !outline.result?.length) fail(`${sample.name}: syntax-only outline stopped working`);
    send({ method: "textDocument/didChange", params: {
      textDocument: { uri, version: 2 }, contentChanges: [{ text: "<Grid></" }],
    } });
    send({ id: ++id, method: "textDocument/completion", params: {
      textDocument: { uri }, position: { line: 0, character: 8 },
    } });
    const closing = await waitFor(responseFor(id), 10000, `${sample.name} closing tag`);
    if (closing.error || !closing.result?.items?.some(item => item.textEdit?.newText === "Grid>")) {
      fail(`${sample.name}: syntax-only closing tag missing`);
    }
    if (statuses.some(status => status.uri === uri && ["ready", "framework-ready"].includes(status.state)) ||
        restoreNotifications.some(notification => notification.projectPath === project) ||
        buildNotifications.some(notification => notification.projectPath === project) ||
        existsSync(marker)) {
      fail(`${sample.name}: unconfirmed project entered semantic/restore/build paths`);
    }
    send({ method: "textDocument/didClose", params: { textDocument: { uri } } });
    console.log(`[ok] ${sample.name}: explicit WinUI eligibility warning, no semantic fallback or restore/build, outline retained`);
  }

  const originalProject = readFileSync(fixtureProject, "utf8");
  const disabledProject = originalProject.replace("<UseWinUI>true</UseWinUI>", "<UseWinUI>false</UseWinUI>");
  if (disabledProject === originalProject) fail("eligibility transition fixture has no UseWinUI setting");
  const changed = () => send({
    method: "workspace/didChangeWatchedFiles",
    params: { changes: [{ uri: pathToFileURL(fixtureProject).href, type: 2 }] },
  });
  const statusIs = state => message =>
    message.method === "winui-xaml/projectContextStatus" &&
    message.params?.uri === fixtureUri && message.params?.state === state;
  const rejected = waitFor(statusIs("winui-required"), 30000, "previously eligible project rejected");
  try {
    writeFileSync(fixtureProject, disabledProject);
    changed();
    await rejected;
    for (const method of ["hover", "completion"]) {
      send({ id: ++id, method: `textDocument/${method}`, params: {
        textDocument: { uri: fixtureUri }, position: { line: 0, character: 2 },
      } });
      const response = await waitFor(responseFor(id), 10000, `ineligible cached ${method}`);
      if (response.error || (method === "hover" ? response.result !== null : response.result?.items?.length)) {
        throw new Error(`previously eligible project retained cached ${method}: ${JSON.stringify(response)}`);
      }
    }
  } finally {
    writeFileSync(fixtureProject, originalProject);
    changed();
  }
  await waitFor(statusIs("ready"), 90000, "project becomes eligible again");
  console.log("[ok] project eligibility changes discard semantic caches and recover without a server restart");
}
