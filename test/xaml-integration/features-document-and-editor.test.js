"use strict";

// Language features driven through VS Code's completion, navigation, and diagnostics APIs. Prefer presence checks because VS Code merges word suggestions into completion results.

const assert = require("node:assert");
const path = require("node:path");
const vscode = require("vscode");
const h = require("./helper");

const CS = "SmokePage.xaml.cs";
const APP = "App.xaml";
const MERGED_RESOURCES = "MergedResources.xaml";

// A <Page> header with x:Class so the server resolves the real SmokeFixture project (types, x:Bind targets, event handlers, App.xaml resources).
function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

describe("WinUI XAML — document symbols", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("returns the element tree with x:Name annotations", async () => {
    const syms = await h.symbolsAt(page('<Grid>\n    <Button x:Name="GoButton" />\n  </Grid>'));
    const names = h.flattenSymbols(syms);
    assert.ok(names.some((n) => /Page/.test(n)), `expected Page; got ${names.join(", ")}`);
    assert.ok(names.some((n) => /Grid/.test(n)), "expected Grid");
    assert.ok(names.some((n) => /Button/.test(n) && /GoButton/.test(n)), `expected Button (GoButton); got ${names.join(", ")}`);
  });
});

describe("WinUI XAML — diagnostics", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("flags an unknown element in a known namespace", async () => {
    const diags = await h.diagnosticsFor(
      page("<Buton />"),
      (d) => d.some((x) => /Buton/.test(x.message))
    );
    const hit = diags.find((x) => /Buton/.test(x.message));
    assert.ok(hit, `expected a diagnostic mentioning Buton; got ${JSON.stringify(diags.map((d) => d.message))}`);
  });

  it("reports no diagnostics for valid markup", async () => {
    // Wait for didChange to replace stale diagnostics with an empty set.
    const diags = await h.diagnosticsFor(page('<Button Content="Hi" />'), (d) => d.length === 0, 8000);
    assert.deepStrictEqual(
      diags.map((d) => `${d.code}:${d.message}`),
      [],
      "expected zero diagnostics for valid markup"
    );
  });

  it("publishes binding and directive parity diagnostics through VS Code", async () => {
    const buffer = `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage" mc:Ignorable="d missing">\n` +
      '  <TextBlock Text="{x:Bind (Grid.Rwo)}" />\n' +
      '  <TextBlock Text="{x:Bind OnGo_Click()}" />\n' +
      '  <Grid d:DataContext="{d:DesignInstance Type=local:Missing}" />\n' +
      "</Page>";
    const expected = new Set(["WXAML0004", "WXAML0009", "WXAML0010", "WXAML0011"]);
    const diagnostics = await h.diagnosticsFor(
      buffer,
      (items) => [...expected].every((code) => items.some((item) =>
          (typeof item.code === "object" ? String(item.code.value) : String(item.code)) === code))
    );
    const codes = new Set(diagnostics.map((item) =>
      typeof item.code === "object" ? String(item.code.value) : String(item.code)));
    for (const code of expected) {
      assert.ok(codes.has(code), `expected ${code}; got ${JSON.stringify([...codes])}`);
    }
  });
});

describe("WinUI XAML — references (Shift+F12)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // A self-contained page: one x:Name declaration + an ElementName usage + a Storyboard.TargetName usage.
  function namePage(caretMarkup) {
    return (
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Button ${caretMarkup} Content="Go" />\n` +
      `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`
    );
  }

  it("finds all x:Name references from the declaration (declaration + usages)", async () => {
    const refs = await h.referencesAt(namePage('x:Name="Go|Button"'));
    assert.strictEqual(refs.length, 3, `expected 3 references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "GoButton"), `all refs should read 'GoButton'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds all x:Name references from an ElementName usage", async () => {
    const refs = await h.referencesAt(
      namePage('x:Name="GoButton"').replace("ElementName=GoButton}", "ElementName=GoBut|ton}")
    );
    assert.ok(refs.length >= 2, `expected at least the 2 usages; got ${refs.length}`);
    assert.ok(refs.every((r) => r.text === "GoButton"), `all refs should read 'GoButton'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds all resource-key references from the x:Key declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Page.Resources>\n` +
      `    <SolidColorBrush x:Key="Bru|sh1" Color="Red" />\n` +
      `  </Page.Resources>\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Brush1}" />\n` +
      `    <Border Background="{ThemeResource Brush1}" />\n` +
      `  </StackPanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.length, 3, `expected 3 references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "Brush1"), `all refs should read 'Brush1'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("returns nothing when the caret is not on a reference", async () => {
    const refs = await h.referencesAt(namePage('x:Name="GoButton"').replace("<StackPanel>", "<StackPa|nel>"));
    assert.strictEqual(refs.length, 0, `expected 0 references on a plain element tag; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("finds resource-key references across project files (App.xaml declaration + other pages)", async () => {
    // SmokeAccentBrush is DECLARED in App.xaml and USED in SmokePage + DiPage. A single usage in the open buffer must resolve to references project-wide (read-only), spanning three files, with no bin/obj copy.
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Smoke|AccentBrush}" />\n` +
      `  </StackPanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    const endsWith = (needle) => refs.filter((r) => r.fsPath.toLowerCase().endsWith(needle)).length;
    assert.ok(
      !refs.some((r) => /[\\/]obj[\\/]/i.test(r.fsPath)),
      `references must not include build-output (obj) copies; got ${JSON.stringify(refs.map((r) => r.fsPath))}`
    );
    assert.strictEqual(refs.length, 3, `expected 3 cross-file references; got ${refs.length}: ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("app.xaml"), 1, `expected the App.xaml declaration; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("dipage.xaml"), 1, `expected the DiPage usage; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
    assert.strictEqual(endsWith("smokepage.xaml"), 1, `expected the open-buffer usage; got ${JSON.stringify(refs.map((r) => r.fsPath))}`);
  });
});

describe("WinUI XAML — RelativePanel + Setter.Target element references", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // RelativePanel targets and the pre-dot VSM Setter target segment are x:Name references.

  it("navigates F12 from a RelativePanel.RightOf value to the x:Name declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <RelativePanel>\n` +
      `    <TextBox x:Name="Anchor" />\n` +
      `    <Button RelativePanel.RightOf="An|chor" />\n` +
      `  </RelativePanel>\n</Page>`;
    // The multi-line h.NS header shifts line numbers, so locate the declaration line dynamically.
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Anchor"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(defs.some((d) => d.line === declLine), `expected the x:Name="Anchor" decl on line ${declLine}; got ${JSON.stringify(defs)}`);
  });

  it("finds all RelativePanel alignment references from the x:Name declaration", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <RelativePanel>\n` +
      `    <TextBox x:Name="An|chor" />\n` +
      `    <Button RelativePanel.RightOf="Anchor" RelativePanel.AlignTopWith="Anchor" />\n` +
      `  </RelativePanel>\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.strictEqual(refs.length, 3, `expected 3 (decl + RightOf + AlignTopWith); got ${refs.length}: ${JSON.stringify(refs.map((r) => r.text))}`);
    assert.ok(refs.every((r) => r.text === "Anchor"), `all refs should read 'Anchor'; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });

  it("renames the Setter.Target element segment only, preserving the .Property tail", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Border x:Name="He|ro" />\n` +
      `  <Setter Target="Hero.Background" Value="Red" />\n</Page>`;
    const { edits, error } = await h.renameAt(buf, "Banner");
    assert.ok(!error, `rename should not error; got ${error}`);
    assert.strictEqual(edits.length, 2, `expected 2 edits (decl + Setter.Target element); got ${edits.length}: ${JSON.stringify(edits)}`);
    assert.ok(edits.every((e) => e.newText === "Banner"), `every edit must set 'Banner'; got ${JSON.stringify(edits.map((e) => e.newText))}`);
    // THE RAZOR: each edit covers exactly "Hero", never "Hero.Background".
    assert.ok(edits.every((e) => e.text === "Hero"), `every edit must cover exactly "Hero" (not "Hero.Background"); got ${JSON.stringify(edits.map((e) => e.text))}`);
  });

  it("does not treat the Setter.Target .Property tail as a reference", async () => {
    // A caret on ".Background" is a member on Hero, not the element name -> no element-name references.
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Border x:Name="Hero" />\n` +
      `  <Setter Target="Hero.Backgr|ound" Value="Red" />\n</Page>`;
    const refs = await h.referencesAt(buf);
    assert.ok(!refs.some((r) => r.text === "Hero"), `the .Property tail must not resolve Hero references; got ${JSON.stringify(refs.map((r) => r.text))}`);
  });
});

describe("WinUI XAML — VSM Setter.Target / Storyboard.TargetProperty member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // VSM Setter and Storyboard member segments resolve on the target element type. Framework members support hover but lack source locations for navigation.

  const setterTarget = (target) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <Border x:Name="Chrome" />\n` +
    `  <Setter Target="${target}" Value="0.5" />\n</Page>`;

  it("hovers the Setter.Target member as the property on the target element's type", async () => {
    const md = await h.hoverAt(setterTarget("Chrome.Opac|ity"));
    assert.ok(/Opacity/.test(md), `expected the Opacity property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the member segment must resolve the property, not the element; got: ${md}`);
  });

  it("F12 on the Setter.Target member does not navigate to the x:Name declaration (framework member, graceful)", async () => {
    const buf = setterTarget("Chrome.Opac|ity");
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Chrome"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(!defs.some((d) => d.line === declLine), `the member caret must not resolve the element decl; got ${JSON.stringify(defs)}`);
  });

  it("F12 on the Setter.Target element segment still navigates to the x:Name declaration (round-80 intact)", async () => {
    const buf = setterTarget("Chr|ome.Opacity");
    const declLine = buf.replaceAll("|", "").split("\n").findIndex((l) => l.includes('x:Name="Chrome"'));
    const defs = await h.definitionsAt(buf);
    assert.ok(defs.some((d) => d.line === declLine), `expected the x:Name="Chrome" decl on line ${declLine}; got ${JSON.stringify(defs)}`);
  });

  it("hovers a bare Storyboard.TargetProperty member against the sibling Storyboard.TargetName element", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Border x:Name="Chrome" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="Opac|ity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`;
    const md = await h.hoverAt(buf);
    assert.ok(/Opacity/.test(md), `expected the Opacity property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the TargetProperty member must resolve the property, not an element; got: ${md}`);
  });
});

describe("WinUI XAML — TemplateBinding property member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // TemplateBinding properties resolve on the template TargetType. Framework members support hover but lack source locations for navigation.

  const tb = (inner) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n` +
    `    <Style TargetType="Button">\n` +
    `      <Setter Property="Template">\n` +
    `        <Setter.Value>\n` +
    `          <ControlTemplate TargetType="Button">\n` +
    `            ${inner}\n` +
    `          </ControlTemplate>\n` +
    `        </Setter.Value>\n` +
    `      </Setter>\n` +
    `    </Style>\n` +
    `  </Page.Resources>\n</Page>`;

  it("hovers the TemplateBinding property as the member on the template's TargetType", async () => {
    const md = await h.hoverAt(tb('<Border Background="{TemplateBinding Back|ground}" />'));
    assert.ok(/Background/.test(md), `expected the Background property; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `the TemplateBinding property must resolve a member, not an element; got: ${md}`);
  });

  it("F12 on the TemplateBinding member returns nothing for a framework property (graceful metadata boundary)", async () => {
    const defs = await h.definitionsAt(tb('<Border Background="{TemplateBinding Back|ground}" />'));
    assert.strictEqual(defs.length, 0, `a framework member has no source; expected no definitions, got ${JSON.stringify(defs)}`);
  });

  it("caret on the TemplateBinding extension name still shows the macro description, not a member", async () => {
    const md = await h.hoverAt(tb('<Border Background="{Templ|ateBinding Background}" />'));
    assert.ok(/TemplateBinding/.test(md) && /templated (control|parent)/i.test(md), `expected the macro description; got: ${md}`);
  });

  it("a property not on the TargetType resolves nothing (no leak)", async () => {
    const md = await h.hoverAt(tb('<Border Background="{TemplateBinding Zork|le}" />'));
    assert.strictEqual(md, "", `an unknown member on the TargetType should not hover; got: ${md}`);
  });
});

describe("WinUI XAML — Storyboard.TargetProperty parenthesized (Owner.Property) member navigation", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Parenthesized Storyboard qualifiers resolve their explicit owner independently of TargetName. Framework symbols support hover but lack source locations for navigation.

  const sb = (tp) =>
    `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
    `  <StackPanel>\n` +
    `    <Border x:Name="AttachedProbe" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="AttachedProbe" Storyboard.TargetProperty="${tp}" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>\n</Page>`;

  it("hovers an instance member of the explicitly named owner type", async () => {
    const md = await h.hoverAt(sb("(UIElement.Opac|ity)"));
    assert.ok(/Opacity/.test(md) && /UIElement/.test(md), `expected UIElement.Opacity; got: ${md}`);
    assert.ok(!/\(element\)/.test(md), `must resolve a member, not an element; got: ${md}`);
  });

  it("hovers an attached member with the attached-property framing", async () => {
    const md = await h.hoverAt(sb("(Canvas.Le|ft)"));
    assert.ok(/attached property/.test(md) && /Canvas\.Left/.test(md), `expected the attached-property framing; got: ${md}`);
  });

  it("a caret on the owner segment resolves the owner TYPE, not the member", async () => {
    const md = await h.hoverAt(sb("(UIEle|ment.Opacity)"));
    assert.ok(/class/.test(md) && /UIElement/.test(md), `expected the UIElement type; got: ${md}`);
    assert.ok(!/attached property/.test(md), `an owner caret must not render the attached-property framing; got: ${md}`);
  });

  it("resolves the member of the SECOND group in a chained qualifier", async () => {
    const md = await h.hoverAt(sb("(UIElement.RenderTransform).(CompositeTransform.Trans|lateX)"));
    assert.ok(/TranslateX/.test(md) && /CompositeTransform/.test(md), `expected CompositeTransform.TranslateX; got: ${md}`);
  });

  it("F12 on a framework member returns nothing (graceful metadata boundary)", async () => {
    const defs = await h.definitionsAt(sb("(UIElement.Opac|ity)"));
    assert.strictEqual(defs.length, 0, `a framework member has no source; expected no definitions, got ${JSON.stringify(defs)}`);
  });
});

describe("WinUI XAML — document highlights", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // vscode.DocumentHighlightKind client enum: Text=0, Read=1, Write=2 (the language client maps the LSP wire kinds 1/2/3 down by one). So the declaration is Write=2 and usages are Read=1 here.
  function namePage(caretMarkup) {
    return (
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <StackPanel>\n` +
      `    <Button ${caretMarkup} Content="Go" />\n` +
      `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
      `    <Storyboard>\n` +
      `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
      `    </Storyboard>\n` +
      `  </StackPanel>\n</Page>`
    );
  }

  it("highlights the x:Name declaration (Write) and all usages (Read)", async () => {
    const hls = await h.highlightsAt(namePage('x:Name="Go|Button"'));
    assert.strictEqual(hls.length, 3, `expected 3 highlights; got ${hls.length}: ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.ok(hls.every((x) => x.text === "GoButton"), `all highlights should read 'GoButton'; got ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 2).length, 1, `expected exactly 1 Write (declaration) highlight; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 1).length, 2, `expected 2 Read (usage) highlights; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
  });

  it("highlights resource-key occurrences from a usage", async () => {
    const buf =
      `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n` +
      `  <Page.Resources>\n` +
      `    <SolidColorBrush x:Key="Brush1" Color="Red" />\n` +
      `  </Page.Resources>\n` +
      `  <StackPanel>\n` +
      `    <Border Background="{StaticResource Bru|sh1}" />\n` +
      `    <Border Background="{ThemeResource Brush1}" />\n` +
      `  </StackPanel>\n</Page>`;
    const hls = await h.highlightsAt(buf);
    assert.strictEqual(hls.length, 3, `expected 3 highlights; got ${hls.length}: ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.ok(hls.every((x) => x.text === "Brush1"), `all highlights should read 'Brush1'; got ${JSON.stringify(hls.map((x) => x.text))}`);
    assert.strictEqual(hls.filter((x) => x.kind === 2).length, 1, `expected exactly 1 Write (declaration) highlight; got kinds ${JSON.stringify(hls.map((x) => x.kind))}`);
  });

  it("does not contribute name/key highlights when the caret is on a plain element tag", async () => {
    const hls = await h.highlightsAt(namePage('x:Name="GoButton"').replace("<StackPanel>", "<StackPa|nel>"));
    // vscode.executeDocumentHighlights merges VS Code's built-in XML tag-match highlighter (it highlights the <StackPanel>/</StackPanel> pair). Our server must not add any x:Name/x:Key highlight here — so no highlight may read 'GoButton'. (The server-level "exactly 0" guarantee is covered by the stdio smoke.)
    assert.ok(
      hls.every((x) => x.text !== "GoButton"),
      `server must not resolve a name from a plain element tag; got ${JSON.stringify(hls.map((x) => x.text))}`
    );
  });
});

describe("WinUI XAML — document formatting", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("reindents nested elements to the configured indent (2 spaces)", async () => {
    const messy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
    const { formatted } = await h.formatDoc(messy, { tabSize: 2, insertSpaces: true });
    assert.strictEqual(formatted, "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>");
  });

  it("honors tabSize / insertSpaces (4-space indent)", async () => {
    const messy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
    const { formatted } = await h.formatDoc(messy, { tabSize: 4, insertSpaces: true });
    assert.strictEqual(formatted, "<Page>\n    <Grid>\n        <Button />\n    </Grid>\n</Page>");
  });

  it('preserves xml:space="preserve" content byte-for-byte while reindenting its tag', async () => {
    const src = '<Page>\n<TextBlock xml:space="preserve">\n      keep  this\n   text</TextBlock>\n</Page>';
    const { formatted } = await h.formatDoc(src);
    assert.ok(
      formatted.includes("\n      keep  this\n   text</TextBlock>"),
      `significant whitespace changed: ${JSON.stringify(formatted)}`
    );
    assert.ok(
      formatted.includes('  <TextBlock xml:space="preserve">'),
      `open tag not reindented: ${JSON.stringify(formatted)}`
    );
  });

  it("does not alter significant inline text content", async () => {
    const src = "<Page>\n<TextBlock>Hello  World</TextBlock>\n</Page>";
    const { formatted } = await h.formatDoc(src);
    assert.ok(
      formatted.includes("<TextBlock>Hello  World</TextBlock>"),
      `inline text changed: ${JSON.stringify(formatted)}`
    );
  });

  it("leaves an already-formatted document unchanged (idempotent, zero edits)", async () => {
    const clean = "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>";
    const { formatted, editCount } = await h.formatDoc(clean);
    assert.strictEqual(editCount, 0, `expected no edits on an already-formatted doc; got ${editCount}`);
    assert.strictEqual(formatted, clean);
  });

  it("provides on-type indentation after a completed tag", async () => {
    const source = "<Page>\n<Grid>";
    await h.setBuffer(source);
    const edits = await vscode.commands.executeCommand(
      "vscode.executeFormatOnTypeProvider",
      h.getDoc().uri,
      new vscode.Position(1, 6),
      ">",
      { tabSize: 2, insertSpaces: true }
    );
    assert.ok(
      (edits || []).some((edit) => edit.newText === "  "),
      `expected an on-type indentation edit; got ${JSON.stringify(edits || [])}`
    );
  });
});

describe("WinUI XAML — editor refactors", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("surrounds every non-empty selection and contributes selection refactors", async () => {
    const source = "<Page>\n  <TextBlock />\n  <Button />\n</Page>";
    await h.setBuffer(source);
    const editor = await vscode.window.showTextDocument(h.getDoc(), { preview: false });
    editor.selections = [
      new vscode.Selection(1, 2, 1, 15),
      new vscode.Selection(2, 2, 2, 12),
    ];

    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      h.getDoc().uri,
      editor.selections[0],
      "refactor.surround"
    );
    assert.ok((actions || []).some((action) => action.title === "Surround with Border"));

    await vscode.commands.executeCommand("winui-xaml.surroundWith", "Border");
    const result = h.getDoc().getText();
    assert.strictEqual((result.match(/<Border>/g) || []).length, 2);
    assert.match(result, /<Border>\r?\n\s*<TextBlock \/>\r?\n\s*<\/Border>/);
    assert.match(result, /<Border>\r?\n\s*<Button \/>\r?\n\s*<\/Border>/);
  });

  it("offers surround refactors in untitled XAML documents", async () => {
    const smokeDoc = h.getDoc();
    const untitled = await vscode.workspace.openTextDocument({
      language: "xaml",
      content: "<Button />",
    });
    const editor = await vscode.window.showTextDocument(untitled, { preview: false });
    editor.selection = new vscode.Selection(0, 0, 0, untitled.getText().length);

    try {
      const actions = await vscode.commands.executeCommand(
        "vscode.executeCodeActionProvider",
        untitled.uri,
        editor.selection,
        "refactor.surround"
      );
      assert.ok((actions || []).some((action) => action.title === "Surround with Grid"));
    } finally {
      await vscode.window.showTextDocument(smokeDoc, { preview: false });
    }
  });
});

describe("WinUI XAML — folding ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("folds a multi-line element from its open tag to its end tag", async () => {
    const ranges = await h.foldingRangesAt("<Grid>\n  <Button />\n</Grid>");
    assert.ok(
      ranges.some((r) => r.start === 0 && r.end === 2),
      `expected a [0,2] element fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("does not fold a single-line element", async () => {
    const ranges = await h.foldingRangesAt("<Grid><Button /></Grid>");
    assert.ok(
      !ranges.some((r) => r.start === 0),
      `single-line element should not fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("tags a multi-line comment as a comment fold", async () => {
    const ranges = await h.foldingRangesAt("<!-- line one\n     line two\n     line three -->");
    assert.ok(
      ranges.some((r) => r.start === 0 && r.kind === "comment"),
      `expected a comment fold at line 0; got ${JSON.stringify(ranges)}`
    );
  });

  it("pairs #region / #endregion comments as a region fold", async () => {
    const ranges = await h.foldingRangesAt(
      "<Grid>\n  <!-- #region Buttons -->\n  <Button />\n  <!-- #endregion -->\n</Grid>"
    );
    assert.ok(
      ranges.some((r) => r.kind === "region" && r.start === 1 && r.end === 3),
      `expected a [1,3] region fold; got ${JSON.stringify(ranges)}`
    );
  });

  it("never emits an inverted or degenerate range, even on malformed markup", async () => {
    const ranges = await h.foldingRangesAt("<Grid>\n  <Button />\n</Wrong>");
    assert.ok(
      ranges.every((r) => r.end > r.start),
      `every fold must span >=2 lines; got ${JSON.stringify(ranges)}`
    );
  });
});

describe("WinUI XAML — document color", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("emits a swatch for a full-value hex attribute with the right channels", async () => {
    const colors = await h.documentColorsAt('<Rectangle Fill="#FF0000" />');
    const swatch = colors.find((c) => c.text === "#FF0000");
    assert.ok(swatch, `expected a #FF0000 swatch; got ${JSON.stringify(colors)}`);
    assert.ok(Math.abs(swatch.color.red - 1) < 0.01, "red channel");
    assert.ok(Math.abs(swatch.color.green) < 0.01, "green channel");
    assert.ok(Math.abs(swatch.color.blue) < 0.01, "blue channel");
    assert.ok(Math.abs(swatch.color.alpha - 1) < 0.01, "alpha channel");
  });

  it("does not emit a swatch for a non-color value or an embedded hex substring", async () => {
    const plain = await h.documentColorsAt('<TextBlock Text="hello world" />');
    assert.strictEqual(plain.length, 0, `non-color value should have no swatch; got ${JSON.stringify(plain)}`);
    const embedded = await h.documentColorsAt('<TextBlock Text="#FF0000 is red" />');
    assert.strictEqual(embedded.length, 0, `embedded hex is not a color value; got ${JSON.stringify(embedded)}`);
  });

  it("skips markup-extension values", async () => {
    const colors = await h.documentColorsAt('<Rectangle Fill="{StaticResource Brush1}" />');
    assert.strictEqual(colors.length, 0, `markup extension should have no swatch; got ${JSON.stringify(colors)}`);
  });

  it("detects short hex and 8-digit ARGB with alpha", async () => {
    const short = await h.documentColorsAt('<Rectangle Fill="#f00" />');
    const s = short.find((c) => c.text === "#f00");
    assert.ok(s && Math.abs(s.color.red - 1) < 0.01 && Math.abs(s.color.green) < 0.01, `#f00 -> red; got ${JSON.stringify(short)}`);

    const argb = await h.documentColorsAt('<Rectangle Fill="#80FF0000" />');
    const a = argb.find((c) => c.text === "#80FF0000");
    assert.ok(a, `expected #80FF0000 swatch; got ${JSON.stringify(argb)}`);
    assert.ok(Math.abs(a.color.alpha - 0x80 / 255) < 0.01, `alpha ~0x80; got ${a.color.alpha}`);
    assert.ok(Math.abs(a.color.red - 1) < 0.01, "red full");
  });

  it("offers bounded hex write-backs for a picked opaque color", async () => {
    const buffer = '<Rectangle Fill="#FF0000" />';
    const colors = await h.documentColorsAt(buffer);
    const swatch = colors.find((c) => c.text === "#FF0000");
    assert.ok(swatch, "swatch present");
    const presentations = await h.colorPresentationsAt(
      buffer,
      { red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255, alpha: 1 },
      swatch.range
    );
    const labels = presentations.map((p) => p.label);
    assert.ok(labels.includes("#3B82F6"), `expected #3B82F6; got ${labels.join(",")}`);
    assert.ok(labels.includes("#FF3B82F6"), `expected #FF3B82F6; got ${labels.join(",")}`);
    for (const p of presentations) {
      assert.ok(p.editRange, `presentation '${p.label}' must carry a textEdit`);
      assert.strictEqual(p.editRange.start.character, swatch.range.start.character, "edit start == literal start");
      assert.strictEqual(p.editRange.end.character, swatch.range.end.character, "edit end == literal end");
      assert.strictEqual(p.newText, p.label, "write-back text equals the label");
    }
  });

  it("offers #AARRGGBB first for a translucent picked color", async () => {
    const buffer = '<Rectangle Fill="#FF0000" />';
    const colors = await h.documentColorsAt(buffer);
    const swatch = colors.find((c) => c.text === "#FF0000");
    const presentations = await h.colorPresentationsAt(
      buffer,
      { red: 1, green: 0, blue: 0, alpha: 0x80 / 255 },
      swatch.range
    );
    assert.strictEqual(presentations[0].label, "#80FF0000", `expected #80FF0000 first; got ${JSON.stringify(presentations.map((p) => p.label))}`);
  });
});

describe("WinUI XAML — selection ranges", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  function assertWellFormed(caret, ranges) {
    assert.ok(ranges.length >= 1, `expected at least one selection range; got ${JSON.stringify(ranges)}`);
    // innermost contains the caret
    const inner = ranges[0];
    const containsCaret =
      (caret.line > inner.start.line || (caret.line === inner.start.line && caret.character >= inner.start.character)) &&
      (caret.line < inner.end.line || (caret.line === inner.end.line && caret.character <= inner.end.character));
    assert.ok(containsCaret, `innermost range must contain the caret; caret=${JSON.stringify(caret)} inner=${JSON.stringify(inner)}`);
    // VS Code merges our provider's chain with its built-in selection-range providers, which can emit equal consecutive ranges (benign editor artifact
    const chain = [];
    for (const r of ranges) {
      const p = chain[chain.length - 1];
      if (p && p.start.line === r.start.line && p.start.character === r.start.character &&
        p.end.line === r.end.line && p.end.character === r.end.character) continue;
      chain.push(r);
    }
    // strict containment up the chain
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const startOk = b.start.line < a.start.line || (b.start.line === a.start.line && b.start.character <= a.start.character);
      const endOk = b.end.line > a.end.line || (b.end.line === a.end.line && b.end.character >= a.end.character);
      const strict = (b.start.line !== a.start.line || b.start.character !== a.start.character) ||
        (b.end.line !== a.end.line || b.end.character !== a.end.character);
      assert.ok(startOk && endOk && strict, `level ${i + 1} must strictly contain level ${i}: ${JSON.stringify({ a, b })}`);
    }
    // outermost is the whole document
    const outer = ranges[ranges.length - 1];
    assert.strictEqual(outer.start.line, 0, `outermost must start at line 0; got ${JSON.stringify(outer)}`);
    assert.strictEqual(outer.start.character, 0, `outermost must start at character 0; got ${JSON.stringify(outer)}`);
  }

  it("expands from an attribute value into strictly nested ranges ending at the document", async () => {
    const { caret, ranges } = await h.selectionRangesAt('<Grid Background="#FF00|00" />');
    assertWellFormed(caret, ranges);
    assert.ok(ranges.length >= 3, `expected several nested levels; got ${ranges.length}`);
  });

  it("produces ancestor element levels for a deeply nested caret", async () => {
    const { caret, ranges } = await h.selectionRangesAt(
      "<Page>\n  <Grid>\n    <Button Content=\"H|i\" />\n  </Grid>\n</Page>"
    );
    assertWellFormed(caret, ranges);
    // value text -> quoted value -> attribute -> Button open/element -> Grid -> Page -> document
    assert.ok(ranges.length >= 5, `expected ancestor levels; got ${ranges.length}: ${JSON.stringify(ranges)}`);
  });

  it("stays well-formed on malformed / unterminated markup", async () => {
    const { caret, ranges } = await h.selectionRangesAt('<Grid><Button Content="x|x"');
    assertWellFormed(caret, ranges);
  });
});

describe("WinUI XAML — linked editing", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("returns both tag-name ranges from the open tag name", async () => {
    const { ranges } = await h.linkedEditingAt("<Sta|ckPanel>\n  <Button />\n</StackPanel>");
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "StackPanel"), `both ranges must cover 'StackPanel'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
    // open name (line 0) precedes the end name (line 2)
    assert.ok(ranges[0].start.line < ranges[1].start.line, `open name must precede end name; got ${JSON.stringify(ranges)}`);
  });

  it("returns both tag-name ranges from the end tag name", async () => {
    const { ranges } = await h.linkedEditingAt("<StackPanel>\n  <Button />\n</Stack|Panel>");
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "StackPanel"), `both ranges must cover 'StackPanel'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
  });

  it("links a prefixed element over its whole qualified name", async () => {
    const { ranges } = await h.linkedEditingAt('<Page xmlns:local="using:App">\n  <local:MyCtl|></local:MyCtl>\n</Page>');
    assert.strictEqual(ranges.length, 2, `expected 2 linked ranges; got ${JSON.stringify(ranges)}`);
    assert.ok(ranges.every((r) => r.text === "local:MyCtl"), `both ranges must cover 'local:MyCtl'; got ${JSON.stringify(ranges.map((r) => r.text))}`);
  });

  it("does not link a self-closing element", async () => {
    const { ranges } = await h.linkedEditingAt("<StackPanel>\n  <But|ton />\n</StackPanel>");
    assert.strictEqual(ranges.length, 0, `self-closing element must not link; got ${JSON.stringify(ranges)}`);
  });

  it("does not link when the caret is on an attribute", async () => {
    const { ranges } = await h.linkedEditingAt('<Grid Wid|th="1"></Grid>');
    assert.strictEqual(ranges.length, 0, `caret on an attribute must not link; got ${JSON.stringify(ranges)}`);
  });
});

describe("WinUI XAML — document links", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  // Normalize path separators and use schemeless paths to exclude VS Code's URL detector.
  const endsWith = (p, name) => !!p && p.replace(/\\/g, "/").toLowerCase().endsWith("/" + name.toLowerCase());

  it("links a ResourceDictionary Source that exists on disk", async () => {
    const links = await h.documentLinksAt('<ResourceDictionary Source="App.xaml" />');
    const mine = links.filter((l) => l.text === "App.xaml");
    assert.strictEqual(mine.length, 1, `expected 1 link over App.xaml; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "App.xaml"), `target must resolve to App.xaml on disk; got ${JSON.stringify(mine[0])}`);
  });

  it("does not link a ResourceDictionary Source that is missing on disk", async () => {
    const links = await h.documentLinksAt('<ResourceDictionary Source="DoesNotExist.xaml" />');
    assert.strictEqual(links.filter((l) => l.text.endsWith(".xaml")).length, 0, `a missing target must not link; got ${JSON.stringify(links)}`);
  });

  it("links each existing Source under MergedDictionaries", async () => {
    const buffer =
      "<ResourceDictionary>\n" +
      "  <ResourceDictionary.MergedDictionaries>\n" +
      '    <ResourceDictionary Source="App.xaml" />\n' +
      '    <ResourceDictionary Source="Page2.xaml" />\n' +
      "  </ResourceDictionary.MergedDictionaries>\n" +
      "</ResourceDictionary>";
    const links = await h.documentLinksAt(buffer);
    const covered = links.map((l) => l.text).sort();
    assert.deepStrictEqual(covered, ["App.xaml", "Page2.xaml"], `expected links over both dictionary sources; got ${JSON.stringify(links)}`);
    assert.ok(links.every((l) => endsWith(l.target, l.text)), `each target must resolve to its file; got ${JSON.stringify(links)}`);
  });

  it("links an Image Source asset that exists on disk (app-root relative)", async () => {
    // Schemeless asset paths avoid links from VS Code's built-in URL detector.
    const links = await h.documentLinksAt('<Image Source="Assets/StoreLogo.png" />');
    const mine = links.filter((l) => l.text === "Assets/StoreLogo.png");
    assert.strictEqual(mine.length, 1, `expected 1 link over the asset path; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "Assets/StoreLogo.png"), `target must resolve to the real asset; got ${JSON.stringify(mine[0])}`);
  });

  it("links a BitmapImage UriSource asset that exists on disk", async () => {
    const links = await h.documentLinksAt('<BitmapImage UriSource="Assets/StoreLogo.png" />');
    const mine = links.filter((l) => l.text === "Assets/StoreLogo.png");
    assert.strictEqual(mine.length, 1, `expected 1 link over the UriSource path; got ${JSON.stringify(links)}`);
    assert.ok(endsWith(mine[0].target, "Assets/StoreLogo.png"), `target must resolve to the real asset; got ${JSON.stringify(mine[0])}`);
  });

  it("does not link a missing Image Source asset", async () => {
    const links = await h.documentLinksAt('<Image Source="Assets/DoesNotExist.png" />');
    assert.strictEqual(links.filter((l) => l.text.endsWith(".png")).length, 0, `a missing asset must not link; got ${JSON.stringify(links)}`);
  });

  it("does not link an Image Source bound by a markup extension", async () => {
    const links = await h.documentLinksAt('<Image Source="{x:Bind LogoUri}" />');
    assert.strictEqual(links.filter((l) => /Logo/.test(l.text)).length, 0, `a bound Source must not link; got ${JSON.stringify(links)}`);
  });
});

describe("WinUI XAML — rename", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("renames an x:Name declaration and its ElementName usage", async () => {
    const buffer =
      '<Grid x:Name="Ro|ot">\n' +
      '  <TextBox Text="{Binding ElementName=Root}" />\n' +
      "</Grid>";
    const res = await h.renameAt(buffer, "Panel");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits (decl + usage); got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Panel"), `every edit must set "Panel"; got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.text === "Root"), `every edit must cover the old name "Root"; got ${JSON.stringify(res.edits)}`);
  });

  it("renames from a usage caret and rewrites the same set", async () => {
    const buffer =
      '<Grid x:Name="Root">\n' +
      '  <TextBox Text="{Binding ElementName=Ro|ot}" />\n' +
      "</Grid>";
    const res = await h.renameAt(buffer, "Panel");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits; got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Panel" && e.text === "Root"), `got ${JSON.stringify(res.edits)}`);
  });

  it("renames an x:Key and its StaticResource usages", async () => {
    const buffer =
      "<Page>\n" +
      "  <Page.Resources>\n" +
      '    <SolidColorBrush x:Key="Acc|ent" Color="Red" />\n' +
      "  </Page.Resources>\n" +
      '  <Grid Background="{StaticResource Accent}" />\n' +
      "</Page>";
    const res = await h.renameAt(buffer, "Brand");
    assert.ok(!res.error, `rename should succeed; got ${JSON.stringify(res)}`);
    assert.strictEqual(res.edits.length, 2, `expected 2 edits (x:Key decl + StaticResource); got ${JSON.stringify(res.edits)}`);
    assert.ok(res.edits.every((e) => e.newText === "Brand" && e.text === "Accent"), `got ${JSON.stringify(res.edits)}`);
  });

  it("rejects an invalid x:Name and applies no edit", async () => {
    const buffer = '<Grid x:Name="Ro|ot" />';
    const res = await h.renameAt(buffer, "1Bad Name");
    assert.ok(res.error || (res.edits || []).length === 0, `an invalid name must not be applied; got ${JSON.stringify(res)}`);
  });

  it("does not offer rename on a non-symbol", async () => {
    const res = await h.renameAt('<Gr|id x:Name="Root" />', "Panel");
    assert.ok((res.edits || []).length === 0, `a caret on the element name must not rename; got ${JSON.stringify(res)}`);
  });
});

describe("WinUI XAML — semantic tokens", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const has = (tokens, text, type) =>
    tokens.some((t) => t.text === text && t.type === type);
  const dump = (tokens) => JSON.stringify(tokens.map((t) => `${t.type}:'${t.text}'`));

  it("advertises the expected legend and classifies element types + attribute members", async () => {
    const { legend, tokens } = await h.semanticTokensAt('<Grid Background="Red" x:Name="Root" />');
    assert.deepStrictEqual(
      legend.tokenTypes,
      ["namespace", "class", "property", "macro", "parameter"],
      `unexpected legend ${JSON.stringify(legend.tokenTypes)}`
    );
    assert.ok(has(tokens, "Grid", "class"), `Grid should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Background", "property"), `Background should be a property; ${dump(tokens)}`);
  });

  it("splits prefixed element + attribute names into a namespace prefix and a local role", async () => {
    const { tokens } = await h.semanticTokensAt('<local:Foo x:Name="Root" />');
    assert.ok(has(tokens, "local", "namespace"), `local: prefix should be a namespace; ${dump(tokens)}`);
    assert.ok(has(tokens, "Foo", "class"), `Foo should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "x", "namespace"), `x: prefix should be a namespace; ${dump(tokens)}`);
    assert.ok(has(tokens, "Name", "property"), `Name should be a property; ${dump(tokens)}`);
    // the x:Name VALUE is intentionally NOT tokenized (names only, not values)
    assert.ok(!tokens.some((t) => t.text === "Root"), `the x:Name value "Root" must not be tokenized; ${dump(tokens)}`);
  });

  it("colors markup-extension names as macros and named arguments as parameters (incl. nested)", async () => {
    const { tokens } = await h.semanticTokensAt('<TextBox Text="{Binding Source={StaticResource Accent}, Path=Text}" />');
    assert.ok(has(tokens, "Binding", "macro"), `Binding should be a macro; ${dump(tokens)}`);
    assert.ok(has(tokens, "Source", "parameter"), `Source should be a parameter; ${dump(tokens)}`);
    assert.ok(has(tokens, "StaticResource", "macro"), `nested StaticResource should be a macro; ${dump(tokens)}`);
    assert.ok(has(tokens, "Path", "parameter"), `Path should be a parameter; ${dump(tokens)}`);
  });

  it("treats property elements and attached properties as members", async () => {
    const buffer =
      "<Grid>\n" +
      "  <Grid.RowDefinitions>\n" +
      '    <RowDefinition Height="Auto" />\n' +
      "  </Grid.RowDefinitions>\n" +
      '  <Border Grid.Row="0" />\n' +
      "</Grid>";
    const { tokens } = await h.semanticTokensAt(buffer);
    assert.ok(has(tokens, "Grid.RowDefinitions", "property"), `property element should be a property; ${dump(tokens)}`);
    assert.ok(has(tokens, "RowDefinition", "class"), `RowDefinition should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Grid.Row", "property"), `attached Grid.Row should be a property; ${dump(tokens)}`);
  });

  it("skips xmlns declarations and returns sorted, single-line, non-overlapping tokens", async () => {
    const buffer =
      '<Page xmlns="http://x" xmlns:local="using:App">\n' +
      '  <Grid x:Name="Root"><Button /></Grid>\n' +
      "</Page>";
    const { tokens } = await h.semanticTokensAt(buffer);
    // xmlns / xmlns:local are structural — no namespace/property token for them.
    assert.ok(!tokens.some((t) => t.text === "xmlns"), `xmlns must not be tokenized; ${dump(tokens)}`);
    assert.ok(has(tokens, "Page", "class"), `Page should be a class; ${dump(tokens)}`);
    assert.ok(has(tokens, "Button", "class"), `Button should be a class; ${dump(tokens)}`);
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const cur = tokens[i];
      const ordered = cur.line > prev.line || (cur.line === prev.line && cur.character >= prev.character + prev.length);
      assert.ok(ordered, `token ${i} ('${cur.text}') overlaps/precedes previous ('${prev.text}'); ${dump(tokens)}`);
    }
  });

  const dumpMod = (tokens) =>
    JSON.stringify(tokens.map((t) => `${t.type}:'${t.text}'${t.modifierNames.includes("defaultLibrary") ? "*" : ""}`));

  it("marks framework names with defaultLibrary and leaves user names unmarked", async () => {
    const buffer =
      `<Page ${h.NS}>\n` +
      '  <Grid x:Name="Root" Background="{StaticResource Accent}">\n' +
      '    <local:Foo Tag="{local:MyExt}" />\n' +
      "  </Grid>\n" +
      "</Page>";
    const { legend, tokens } = await h.semanticTokensAt(buffer);
    assert.ok(legend.tokenModifiers.includes("defaultLibrary"), `legend should advertise defaultLibrary; ${JSON.stringify(legend.tokenModifiers)}`);
    const isFw = (text, type) => tokens.some((t) => t.text === text && t.type === type && t.modifierNames.includes("defaultLibrary"));
    const notFw = (text) => tokens.filter((t) => t.text === text).every((t) => !t.modifierNames.includes("defaultLibrary"));
    // Framework: default-ns element (presentation), Page, the x: directive prefix + name, framework markup ext.
    assert.ok(isFw("Page", "class"), `Page should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("Grid", "class"), `Grid should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("x", "namespace"), `x prefix should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("Name", "property"), `Name should be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(isFw("StaticResource", "macro"), `StaticResource should be defaultLibrary; ${dumpMod(tokens)}`);
    // User: the local: prefix + its element name + user markup ext; an unprefixed member is never marked.
    assert.ok(notFw("local"), `local prefix must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("Foo"), `Foo must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("MyExt"), `MyExt must NOT be defaultLibrary; ${dumpMod(tokens)}`);
    assert.ok(notFw("Background"), `unprefixed Background must NOT be defaultLibrary; ${dumpMod(tokens)}`);
  });

  it("without xmlns declarations, no token carries defaultLibrary", async () => {
    const { tokens } = await h.semanticTokensAt('<Grid x:Name="Root"><Button /></Grid>');
    assert.ok(tokens.every((t) => !t.modifierNames.includes("defaultLibrary")), `no prefix resolves, so nothing is framework; ${dumpMod(tokens)}`);
  });

  it("semanticTokens/range returns only tokens overlapping the requested range", async () => {
    const buffer = "<Grid>\n  <Button />\n  <TextBox />\n</Grid>";
    const range = { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } };
    const { tokens } = await h.semanticTokensRangeAt(buffer, range);
    assert.ok(has(tokens, "Button", "class"), `range should include the line-1 Button; ${dump(tokens)}`);
    assert.ok(!tokens.some((t) => t.text === "TextBox"), `TextBox (line 2) is out of range; ${dump(tokens)}`);
    assert.ok(!tokens.some((t) => t.text === "Grid"), `Grid open/end tags (lines 0,3) are out of range; ${dump(tokens)}`);
  });

  it("range tokens are a subset of the full set with identical decoding", async () => {
    const buffer = `<Page ${h.NS}>\n  <Grid x:Name="Root" />\n  <local:Foo />\n</Page>`;
    const { tokens: full } = await h.semanticTokensAt(buffer);
    const { tokens: ranged } = await h.semanticTokensRangeAt(buffer, { start: { line: 1, character: 0 }, end: { line: 1, character: 100 } });
    const line1 = full.filter((t) => t.line === 1).map((t) => `${t.type}:${t.character}:${t.length}:${t.modifiers}:${t.text}`);
    const rangedKeys = ranged.map((t) => `${t.type}:${t.character}:${t.length}:${t.modifiers}:${t.text}`);
    assert.deepStrictEqual(rangedKeys, line1, `ranged tokens should equal the full line-1 subset; ranged=${dump(ranged)} full-line1=${JSON.stringify(line1)}`);
  });
});

describe("WinUI XAML — code actions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const titles = (r) => JSON.stringify(r.actions.map((a) => a.title));

  it("removes only unused root namespaces through source.organizeImports", async () => {
    const buffer =
      '<Page xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n' +
      '      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n' +
      '      xmlns:local="using:SmokeFixture"\n' +
      '      xmlns:unused="using:Unused">\n' +
      '  <local:SmokePage x:Name="kept" />\n' +
      "</Page>";
    await h.setBuffer(buffer);
    const doc = h.getDoc();
    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      vscode.CodeActionKind.SourceOrganizeImports.value
    );
    const action = (actions || []).find((candidate) =>
      candidate.title === "Remove unused XAML namespaces");
    assert.ok(action && action.edit, "expected the namespace organization source action");
    assert.ok(await vscode.workspace.applyEdit(action.edit), "expected namespace edit to apply");
    assert.ok(!doc.getText().includes("xmlns:unused"), "unused namespace should be removed");
    assert.ok(doc.getText().includes("xmlns:local"), "used namespace should be preserved");
    assert.ok(doc.getText().includes("xmlns:x"), "XAML namespace should be preserved");
  });

  it("offers a 'Did you mean?' fix for an unknown element type", async () => {
    const r = await h.codeActionsAt(page("<Buton />"), "WXAML0002", "Buton");
    const fix = r.actions.find((a) => a.title === "Change 'Buton' to 'Button'");
    assert.ok(fix, `expected a "Change 'Buton' to 'Button'" quick fix; got ${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the top suggestion should be preferred");
  });

  it("replaces exactly the flagged span with the chosen name", async () => {
    const r = await h.codeActionsAt(page("<Buton />"), "WXAML0002", "Buton");
    const fix = r.actions.find((a) => a.title === "Change 'Buton' to 'Button'");
    assert.ok(fix, `expected the Button fix; got ${titles(r)}`);
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(edit.newText, "Button", `edit should insert Button; got ${edit.newText}`);
    // The edit must cover EXACTLY the diagnostic's span — never widen into surrounding markup.
    const dr = r.diagnostic.range;
    assert.strictEqual(edit.line, dr.start.line, "edit start line must equal the diagnostic range");
    assert.strictEqual(edit.character, dr.start.character, "edit start char must equal the diagnostic range");
    assert.strictEqual(edit.endLine, dr.end.line, "edit end line must equal the diagnostic range");
    assert.strictEqual(edit.endCharacter, dr.end.character, "edit end char must equal the diagnostic range");
    assert.strictEqual(edit.text, "Buton", `the replaced text should be the flagged token; got ${edit.text}`);
  });

  it("treats a case-only slip as the top fix (XAML is case-sensitive)", async () => {
    const r = await h.codeActionsAt(page("<grid />"), "WXAML0002", "grid");
    const fix = r.actions.find((a) => a.title === "Change 'grid' to 'Grid'");
    assert.ok(fix, `expected a "Change 'grid' to 'Grid'" fix; got ${titles(r)}`);
    assert.strictEqual(fix.isPreferred, true, "the exact-casing correction should be preferred");
  });

  it("offers a fix for an unknown attribute member", async () => {
    const r = await h.codeActionsAt(page('<Button Contnt="Hi" />'), "WXAML0003", "Contnt");
    const fix = r.actions.find((a) => a.title === "Change 'Contnt' to 'Content'");
    assert.ok(fix, `expected a "Change 'Contnt' to 'Content'" fix; got ${titles(r)}`);
    assert.strictEqual(fix.edits[0].newText, "Content", "the attribute fix should insert Content");
  });

  it("offers no fix for an undeclared CUSTOM prefix naming a NON-project type", async () => {
    // 'zzz' is undeclared and 'Widget' is not one of the project's own source types, so there is no using: namespace to infer (and never a "Change …" spelling fix for an undeclared prefix).
    const buffer = `<Page ${h.NS}>\n  <zzz:Widget x:Name="w" />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "zzz");
    assert.ok(
      !r.actions.some((a) => /^Change '/.test(a.title)),
      `an undeclared-prefix error must not carry a "Change …" quick fix; got ${titles(r)}`
    );
    assert.ok(
      !r.actions.some((a) => /^Add xmlns/.test(a.title)),
      `a custom prefix naming a non-project type must not get an "Add xmlns" fix; got ${titles(r)}`
    );
  });

  it('offers \'Add xmlns:PREFIX="using:…"\' for an undeclared CUSTOM prefix naming a PROJECT type', async () => {
    // 'zzz' is undeclared and names the fixture's own SmokeFixture.SmokePage, so the fix infers the using: namespace from the project's type system and declares it on the root.
    const r = await h.codeActionsAt(page("<zzz:SmokePage />"), "WXAML0001", "zzz");
    const fix = r.actions.find((a) => a.title === 'Add xmlns:zzz="using:SmokeFixture"');
    assert.ok(fix, `expected an 'Add xmlns:zzz="using:SmokeFixture"' quick fix; diag=${JSON.stringify(r.diagnostic)} actions=${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "a single inferred namespace should be preferred");
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(edit.newText, ' xmlns:zzz="using:SmokeFixture"', `edit should declare the inferred using: namespace; got ${edit.newText}`);
    // A pure zero-width insertion grouped onto the root's xmlns block.
    assert.strictEqual(edit.line, edit.endLine, "insertion must be zero-width (same line)");
    assert.strictEqual(edit.character, edit.endCharacter, "insertion must be zero-width (same char)");
    assert.strictEqual(edit.text, "", "insertion must not replace any existing text");
    const targetLine = page("<zzz:SmokePage />").split("\n")[edit.line];
    assert.ok(/xmlns:/.test(targetLine), `declaration should group onto an xmlns line; got line ${edit.line} = ${JSON.stringify(targetLine)}`);
  });

  it("offers 'Add xmlns:d declaration' for an undeclared WELL-KNOWN prefix", async () => {
    // h.NS declares d/mc, so use a minimal header (default + x only) to leave 'd' genuinely undeclared.
    const minimalNS =
      'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" ' +
      'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
    const buffer = `<Page ${minimalNS}>\n  <d:Foo />\n</Page>`;
    const r = await h.codeActionsAt(buffer, "WXAML0001", "d");
    const fix = r.actions.find((a) => a.title === "Add xmlns:d declaration");
    assert.ok(fix, `expected an "Add xmlns:d declaration" quick fix; diag=${JSON.stringify(r.diagnostic)} actions=${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the add-xmlns fix should be preferred");
    const edit = fix.edits[0];
    assert.ok(edit, "the fix must carry an edit");
    assert.strictEqual(
      edit.newText,
      ' xmlns:d="http://schemas.microsoft.com/expression/blend/2008"',
      `edit should insert the standard blend namespace; got ${edit.newText}`
    );
    // A pure insertion on the root's open-tag line: zero-width range, replacing no existing text.
    assert.strictEqual(edit.line, edit.endLine, "insertion must be zero-width (same line)");
    assert.strictEqual(edit.character, edit.endCharacter, "insertion must be zero-width (same char)");
    assert.strictEqual(edit.text, "", "insertion must not replace any existing text");
    assert.strictEqual(edit.line, 0, "declaration groups with the existing xmlns on the root's line");
  });

  it("offers a 'Did you mean?' fix for a misspelled x:Bind path member", async () => {
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx}" />'), "WXAML0005", "GreetingTexx");
    const fix = r.actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
    assert.ok(fix, `expected a "Change 'GreetingTexx' to 'GreetingText'" quick fix; got ${titles(r)}`);
    assert.strictEqual(fix.kind, "quickfix", `fix kind should be quickfix; got ${fix.kind}`);
    assert.strictEqual(fix.isPreferred, true, "the top bindable-member suggestion should be preferred");
    const edit = fix.edits[0];
    assert.strictEqual(edit.newText, "GreetingText", `edit should insert GreetingText; got ${edit.newText}`);
    // Single-segment path: the diagnostic span IS the token, so the edit replaces it exactly.
    assert.strictEqual(edit.text, "GreetingTexx", `the replaced text should be the flagged token; got ${edit.text}`);
  });

  it("narrows a dotted x:Bind fix to the bad first segment (keeps the trailing path)", async () => {
    // The first-segment diagnostic underlines the WHOLE value; matchText is that span, while the fix targets just the bad segment so ".Length" is preserved.
    const r = await h.codeActionsAt(page('<TextBlock Text="{x:Bind GreetingTexx.Length}" />'), "WXAML0005", "GreetingTexx.Length");
    const fix = r.actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
    assert.ok(fix, `expected the dotted-path quick fix; got ${titles(r)}`);
    const edit = fix.edits[0];
    assert.strictEqual(edit.newText, "GreetingText", `edit should insert GreetingText; got ${edit.newText}`);
    const dr = r.diagnostic.range;
    // Edit starts at the value start but covers only "GreetingTexx" (12 chars), never the ".Length" tail.
    assert.strictEqual(edit.line, dr.start.line, "edit must start on the diagnostic's line");
    assert.strictEqual(edit.character, dr.start.character, "edit must start at the value start");
    assert.strictEqual(edit.endCharacter, dr.start.character + 12, "edit must cover exactly 'GreetingTexx'");
    assert.ok(edit.endCharacter < dr.end.character, "edit must be narrower than the whole-value span so '.Length' survives");
    assert.strictEqual(edit.text, "GreetingTexx", `the replaced text should be just the bad segment; got ${edit.text}`);
  });
});

// Referenced controls without XmlnsDefinitionAttribute use a generated prefix and xmlns edit. Server-only edit fields distinguish them from VS Code word suggestions.
describe("WinUI XAML — third-party control completion (gap #4)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const TOOLKIT_NS = "CommunityToolkit.WinUI.Controls";
  const XMLNS_EDIT = ` xmlns:controls="using:${TOOLKIT_NS}"`;

  // A <Page> with an EXTRA xmlns already declared on the root (for the prefix-reuse probe).
  function pageWith(extraXmlns, inner) {
    return `<Page ${h.NS}\n    ${extraXmlns}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  }

  it("offers a toolkit control and injects its xmlns on the root", async () => {
    const items = await h.completionEditsAt(page("<Grid><Sett|</Grid>"));
    const card = items.find((i) => i.newText === "controls:SettingsCard");
    assert.ok(card, `expected controls:SettingsCard; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.ok(
      /CommunityToolkit\.WinUI\.Controls \(adds xmlns:controls\)/.test(card.detail || ""),
      `detail should name the namespace + the injected xmlns; got ${card.detail}`
    );
    assert.strictEqual(card.additionalTextEdits.length, 1, "exactly one additional edit (the xmlns injection)");
    const edit = card.additionalTextEdits[0];
    assert.strictEqual(edit.newText, XMLNS_EDIT, `the injected xmlns declaration; got ${edit.newText}`);
    // Pure zero-width insertion (never overwrites existing text).
    assert.deepStrictEqual(edit.range.start, edit.range.end, "the xmlns injection is a zero-width insertion");
  });

  it("also offers SettingsExpander with the same xmlns injection", async () => {
    const items = await h.completionEditsAt(page("<Grid><Sett|</Grid>"));
    const exp = items.find((i) => i.newText === "controls:SettingsExpander");
    assert.ok(exp, `expected controls:SettingsExpander; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.strictEqual(exp.additionalTextEdits.length, 1, "SettingsExpander also injects the xmlns");
    assert.strictEqual(exp.additionalTextEdits[0].newText, XMLNS_EDIT);
  });

  it("filters third-party controls by the typed partial", async () => {
    const items = await h.completionEditsAt(page("<Grid><SettingsC|</Grid>"));
    const names = items.map((i) => i.newText).filter((t) => /^controls:/.test(t || ""));
    assert.ok(names.includes("controls:SettingsCard"), `SettingsC should match SettingsCard; got ${JSON.stringify(names)}`);
    assert.ok(!names.includes("controls:SettingsExpander"), `SettingsC must not match SettingsExpander; got ${JSON.stringify(names)}`);
  });

  it("reuses an already-declared prefix and injects NOTHING", async () => {
    const buf = pageWith(`xmlns:toolkit="using:${TOOLKIT_NS}"`, "<Grid><Sett|</Grid>");
    const items = await h.completionEditsAt(buf);
    const card = items.find((i) => i.newText === "toolkit:SettingsCard");
    assert.ok(card, `expected the declared prefix reused as toolkit:SettingsCard; got ${JSON.stringify(items.map((i) => i.newText))}`);
    assert.strictEqual(card.additionalTextEdits.length, 0, "a declared prefix needs NO xmlns injection");
    assert.strictEqual(card.detail, TOOLKIT_NS, `detail should be the bare namespace (no '(adds …)'); got ${card.detail}`);
    // And it must NOT ALSO offer a controls:-generated duplicate for the same type.
    assert.ok(!items.some((i) => i.newText === "controls:SettingsCard"), "must not double-offer a generated prefix when one is declared");
  });

  it("excludes non-DependencyObject referenced types (DI services stay out)", async () => {
    // "Serv" would match Microsoft.Extensions.DependencyInjection.ServiceCollection/ServiceProvider/… if the DependencyObject-assignability filter were absent — a sharp, non-vacuous negative.
    const items = await h.completionEditsAt(page("<Grid><Serv|</Grid>"));
    const di = items.filter(
      (i) => /Service(Collection|Provider|Descriptor)/.test(i.newText || "") || /DependencyInjection/.test(i.detail || "")
    );
    assert.strictEqual(di.length, 0, `DI service types must never be offered as elements; got ${JSON.stringify(di)}`);
  });
});
