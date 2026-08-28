"use strict";

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function rootPage(extraAttrs, inner = "<Grid />") {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage"\n    ${extraAttrs}>\n  ${inner}\n</Page>`;
}

function noCodeBehindPage(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.DoesNotExist">\n  ${inner}\n</Page>`;
}

function noClassPage(inner) {
  return `<Page ${h.NS}>\n  ${inner}\n</Page>`;
}

const generateActions = (actions) => actions.filter((a) => a.title && a.title.startsWith("Generate event handler"));
const generate = (actions) => generateActions(actions)[0];

function assertUserCodeBehindEdit(gen) {
  assert.ok(gen, "expected a generate action");
  assert.strictEqual(gen.kind, "quickfix", "generate action kind");
  assert.strictEqual(gen.isPreferred, true, "generate action must be preferred");
  assert.ok(gen.edits.length > 0, "generate action must carry edits");

  const paths = gen.edits.map((e) => e.fsPath);
  assert.ok(
    paths.every((p) => /SmokePage\.xaml\.cs$/i.test(p)),
    `all edits must target the user SmokePage.xaml.cs; got ${JSON.stringify(paths)}`
  );
  assert.ok(
    paths.every((p) => !/\.g\.i?\.cs$/i.test(p)),
    `must never target generated .g.cs/.g.i.cs files; got ${JSON.stringify(paths)}`
  );
  assert.ok(
    paths.every((p) => !/[\\\/](obj|bin)[\\\/]/i.test(p)),
    `must never target obj/bin files; got ${JSON.stringify(paths)}`
  );

  const edit = gen.edits.find((e) => /SmokePage\.xaml\.cs$/i.test(e.fsPath));
  assert.ok(edit, `missing SmokePage.xaml.cs edit; got ${JSON.stringify(paths)}`);
  assert.strictEqual(edit.line, edit.endLine, "insertion edit should be zero-width line");
  assert.strictEqual(edit.character, edit.endCharacter, "insertion edit should be zero-width character");
  assert.strictEqual(edit.text, "", "insertion edit should replace no existing text");
  return edit;
}

async function assertGenerate(buffer, handlerName, expectedArgTypes = []) {
  const actions = await h.codeActionsAtCaret(buffer);
  const gen = generate(actions);
  assert.ok(gen, `expected generate action; got ${JSON.stringify(actions.map((a) => a.title))}`);
  assert.strictEqual(gen.title, `Generate event handler '${handlerName}'`);
  assert.strictEqual(gen.command?.command, "winui-xaml.saveGeneratedEventHandler");
  assert.match(gen.command?.arguments?.[0] || "", /SmokePage\.xaml\.cs$/i);
  const edit = assertUserCodeBehindEdit(gen);
  assert.ok(edit.newText.includes(`private void ${handlerName}(`), `stub name mismatch; got ${JSON.stringify(edit.newText)}`);
  for (const type of expectedArgTypes) {
    assert.ok(edit.newText.includes(type), `stub should include ${type}; got ${JSON.stringify(edit.newText)}`);
  }
  return { actions, gen, edit };
}

async function assertNoGenerate(buffer, message) {
  const actions = await h.codeActionsAtCaret(buffer);
  assert.strictEqual(generateActions(actions).length, 0, `${message}; got ${JSON.stringify(actions.map((a) => a.title))}`);
  return actions;
}

function normalize(gen) {
  return {
    title: gen.title,
    kind: gen.kind,
    isPreferred: gen.isPreferred,
    edits: gen.edits.map((e) => ({
      fsPath: e.fsPath,
      line: e.line,
      character: e.character,
      endLine: e.endLine,
      endCharacter: e.endCharacter,
      newText: e.newText,
    })),
  };
}

describe("WinUI XAML — generate event handler #3 red-team", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("offers a preferred quickfix on Click value and name carets with a safe user-code-behind edit", async () => {
    await assertGenerate(page('<Button Click="RtGap3_Value|_Click" Content="Hi" />'), "RtGap3_Value_Click", [
      "object sender",
      "RoutedEventArgs e",
    ]);
    await assertGenerate(page('<Button Cli|ck="RtGap3_Name_Click" Content="Hi" />'), "RtGap3_Name_Click", [
      "object sender",
      "RoutedEventArgs e",
    ]);
  });

  it("uses the actual event delegate signature, not a hardcoded RoutedEventArgs stub", async () => {
    const selection = await assertGenerate(page('<ComboBox SelectionChanged="RtGap3_Sel|ection" />'), "RtGap3_Selection", [
      "SelectionChangedEventArgs e",
    ]);
    assert.ok(!selection.edit.newText.includes("RoutedEventArgs e"), `SelectionChanged was hardcoded: ${JSON.stringify(selection.edit.newText)}`);

    await assertGenerate(page('<Grid PointerPressed="RtGap3_P|ointer" />'), "RtGap3_Pointer", [
      "PointerRoutedEventArgs e",
    ]);

    const size = await assertGenerate(rootPage('SizeChanged="RtGap3_Si|ze"'), "RtGap3_Size", [
      "SizeChangedEventArgs e",
    ]);
    assert.ok(!size.edit.newText.includes("RoutedEventArgs e"), `SizeChanged was hardcoded: ${JSON.stringify(size.edit.newText)}`);
  });

  it("suppresses duplicate generation for existing and inherited members while a missing sibling still works", async () => {
    await assertGenerate(page('<Button Click="RtGap3_DuplicatePositive|_Click" />'), "RtGap3_DuplicatePositive_Click");
    await assertNoGenerate(page('<Button Click="OnGo|_Click" />'), "existing code-behind handler must not be regenerated");
    for (const inherited of ["ToString", "Equals", "OnApplyTemplate"]) {
      await assertNoGenerate(page(`<Button Click="${inherited.slice(0, 2)}|${inherited.slice(2)}" />`), `inherited member ${inherited} must not be generated`);
    }
  });

  it("rejects markup-extension values while a plain event-handler value in the same feature works", async () => {
    await assertGenerate(page('<Button Click="RtGap3_MarkupPositive|_Click" />'), "RtGap3_MarkupPositive_Click");
    for (const value of ["{x:Bind Foo_Click}", "{Binding Foo}", "{StaticResource X}"]) {
      const marked = value.replace("Foo", "Fo|o").replace("X", "X|");
      await assertNoGenerate(page(`<Button Click="${marked}" />`), `markup-extension value ${value} must not generate`);
    }
  });

  it("rejects non-event attributes across common property shapes", async () => {
    await assertGenerate(page('<Button Click="RtGap3_NonEventPositive|_Click" />'), "RtGap3_NonEventPositive_Click");
    for (const attr of ["Foreground", "Content", "Tag", "Width"]) {
      await assertNoGenerate(page(`<Button ${attr}="RtGap3_${attr}|_Nope" />`), `${attr} is not an event`);
    }
  });

  it("rejects prefixed and xmlns attributes", async () => {
    await assertGenerate(page('<Button Click="RtGap3_PrefixPositive|_Click" />'), "RtGap3_PrefixPositive_Click");
    await assertNoGenerate(page('<Button local:Foo="RtGap3_Local|_Nope" />'), "prefixed custom attribute must not generate");
    await assertNoGenerate(page('<Button x:Name="RtGap3_X|Name_Nope" />'), "x:-prefixed attribute must not generate");
    await assertNoGenerate(page('<Button xmlns:zzz="using:Smoke|Fixture" />'), "xmlns declaration must not generate");
  });

  it("rejects empty, whitespace, dotted, spaced, and leading-digit handler values", async () => {
    await assertGenerate(page('<Button Click="RtGap3_IdentifierPositive|_Click" />'), "RtGap3_IdentifierPositive_Click");
    for (const value of ["123Bad", "has space", "a.b", "", "  "]) {
      const withCaret = value.length === 0 ? "|" : value.length === 2 ? " | " : `${value.slice(0, 1)}|${value.slice(1)}`;
      await assertNoGenerate(page(`<Button Click="${withCaret}" />`), `invalid handler value ${JSON.stringify(value)} must not generate`);
    }
  });

  it("is precise about caret context: value and name fire, element/other attribute/whitespace do not", async () => {
    await assertGenerate(page('<Button Click="RtGap3_CaretValue|_Click" Content="Hi" />'), "RtGap3_CaretValue_Click");
    await assertGenerate(page('<Button Clic|k="RtGap3_CaretName_Click" Content="Hi" />'), "RtGap3_CaretName_Click");
    await assertNoGenerate(page('<But|ton Click="RtGap3_Element_Click" Content="Hi" />'), "caret on element name must not generate for Click");
    await assertNoGenerate(page('<Button Click="RtGap3_OtherAttr_Click" Cont|ent="Hi" />'), "caret on a different attribute must not generate for Click");
    await assertNoGenerate(page('<Button Content="Hi" | Click="RtGap3_Whitespace_Click" />'), "caret in whitespace between attributes must not generate");
  });

  it("is deterministic for identical probes", async () => {
    const buffer = page('<Button Click="RtGap3_Deterministic|_Click" />');
    const first = generate((await assertGenerate(buffer, "RtGap3_Deterministic_Click")).actions);
    const second = generate((await assertGenerate(buffer, "RtGap3_Deterministic_Click")).actions);
    assert.deepStrictEqual(normalize(second), normalize(first), "same probe should yield the same action/edit");
  });

  it("is robust on malformed and unbalanced markup", async () => {
    for (const buffer of [
      page('<Button Click="RtGap3_Broken|_Click"'),
      page('<Grid><Button Click="RtGap3_Unbalanced|_Click"></Grid>'),
    ]) {
      const actions = await h.codeActionsAtCaret(buffer);
      assert.ok(Array.isArray(actions), `broken markup should return an action array; got ${JSON.stringify(actions)}`);
    }
  });

  it("selects the right handler when multiple missing events are present on one element or buffer", async () => {
    await assertGenerate(page('<Button Click="RtGap3_MultiA|_Click" PointerPressed="RtGap3_MultiB_Ptr" />'), "RtGap3_MultiA_Click", [
      "RoutedEventArgs e",
    ]);
    await assertGenerate(page('<Button Click="RtGap3_MultiA_Click" PointerPressed="RtGap3_MultiB|_Ptr" />'), "RtGap3_MultiB_Ptr", [
      "PointerRoutedEventArgs e",
    ]);
    await assertGenerate(page('<StackPanel>\n    <Button Click="RtGap3_BufferA|_Click" />\n    <Grid PointerPressed="RtGap3_BufferB_Ptr" />\n  </StackPanel>'), "RtGap3_BufferA_Click");
    await assertGenerate(page('<StackPanel>\n    <Button Click="RtGap3_BufferA_Click" />\n    <Grid PointerPressed="RtGap3_BufferB|_Ptr" />\n  </StackPanel>'), "RtGap3_BufferB_Ptr", [
      "PointerRoutedEventArgs e",
    ]);
  });

  // x:Class resolution is DISK-based across the whole language service — the project resolver reads the on-disk x:Class (XamlProjectResolver.TryReadClassName -> File.ReadAllText)
  it("keeps any offered code-behind edit on the real user partial when the buffer x:Class diverges from disk", async () => {
    await assertGenerate(page('<Button Click="RtGap3_CodeBehindPositive|_Click" />'), "RtGap3_CodeBehindPositive_Click");
    const probes = [
      ["renamed x:Class in buffer", noCodeBehindPage('<Button Click="RtGap3_NoCodeBehind|_Click" />')],
      ["absent x:Class in buffer", noClassPage('<Button Click="RtGap3_NoClass|_Click" />')],
    ];
    for (const [name, buffer] of probes) {
      const actions = await h.codeActionsAtCaret(buffer);
      const gen = generate(actions);
      // Under disk-based resolution an action is expected (disk x:Class still resolves); whether or not it appears, it must never be corruption-unsafe.
      if (gen) {
        assertUserCodeBehindEdit(gen);
      }
    }
  });
});
