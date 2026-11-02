"use strict";

// x:Bind/Bind argument-name documentation.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}
    x:Class="SmokeFixture.SmokePage">
  ${inner}
</Page>`;
}

const OVERLAPPING = [
  "Mode",
  "Converter",
  "ConverterParameter",
  "ConverterLanguage",
  "FallbackValue",
  "TargetNullValue",
  "UpdateSourceTrigger",
];

const X_BIND_ONLY = "BindBack";
const ALL_X_BIND_ARGS = [...OVERLAPPING.slice(0, 6), X_BIND_ONLY, OVERLAPPING[6]];
const BAD_DOC_RESIDUE = /:::|<img|\[!|```/i;

function caretOffset(buffer) {
  return buffer.indexOf("|");
}

const itemsOf = (items, label, detailRe) =>
  items.filter((i) => i.label === label && (!detailRe || detailRe.test(i.detail || "")));

const documentedItemsOf = (items, label, detailRe) =>
  itemsOf(items, label, detailRe).filter((i) => i.documentation);

function docOf(items, label, detailRe) {
  const documented = documentedItemsOf(items, label, detailRe)[0];
  if (documented) return documented.documentation;
  const hits = itemsOf(items, label, detailRe);
  return hits.length ? hits[0].documentation : "";
}

function detailOf(items, label, detailRe) {
  const documented = documentedItemsOf(items, label, detailRe)[0];
  if (documented) return documented.detail || "";
  const hits = itemsOf(items, label, detailRe);
  return hits.length ? hits[0].detail || "" : "";
}

function assertSanitized(doc, reason) {
  assert.ok(!BAD_DOC_RESIDUE.test(doc), `${reason}: unsanitized documentation ${JSON.stringify(doc)}`);
}

function assertBindingDoc(doc, label, reason) {
  assert.ok(doc.length > 0, `${reason}: expected non-empty documentation for ${label}`);
  assert.match(doc, /gets or sets/i, `${reason}: expected Binding-property prose for ${label}; got ${JSON.stringify(doc)}`);
  assertSanitized(doc, reason);
}

function assertNoDocumentedBindingArg(items, label, bindingDoc, reason) {
  const docs = itemsOf(items, label).map((i) => ({ detail: i.detail || "", documentation: i.documentation || "" }));
  assert.ok(
    docs.every((i) => i.documentation !== bindingDoc),
    `${reason}: ${label} leaked Binding documentation; hits=${JSON.stringify(docs)}`
  );
}

async function docsFor(buffer) {
  return h.completionDocsAt(buffer);
}

describe("WinUI XAML — red-team 68 (x:Bind argument-name documentation)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 68 x:Bind empty argument position offers all eight curated labels with documentation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const items = await docsFor(buffer);
    for (const label of ALL_X_BIND_ARGS) {
      const d = docOf(items, label);
      assert.ok(d.length > 0, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} expected documented ${label}; hits=${JSON.stringify(itemsOf(items, label))}`);
      assertSanitized(d, `x:Bind ${label}`);
    }
  });

  it("red-team 68 every overlapping x:Bind arg doc is byte-identical to classic Binding", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, |}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    for (const label of OVERLAPPING) {
      const bindingDoc = docOf(bItems, label);
      const xBindDoc = docOf(xItems, label);
      assertBindingDoc(bindingDoc, label, `classic Binding ${label}`);
      assertBindingDoc(xBindDoc, label, `x:Bind ${label}`);
      assert.strictEqual(xBindDoc, bindingDoc, `${label} doc mismatch; xBind=${JSON.stringify({ detail: detailOf(xItems, label), documentation: xBindDoc })} binding=${JSON.stringify({ detail: detailOf(bItems, label), documentation: bindingDoc })}`);
    }
  });

  it("red-team 68 Bind alias borrows the same Binding docs as x:Bind and classic Binding", async () => {
    const aliasItems = await docsFor(page('<TextBlock Text="{Bind GreetingText, |}" />'));
    const xItems = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const bItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    for (const label of OVERLAPPING) {
      assert.strictEqual(docOf(aliasItems, label), docOf(xItems, label), `{Bind} ${label} doc should equal x:Bind`);
      assert.strictEqual(docOf(aliasItems, label), docOf(bItems, label), `{Bind} ${label} doc should equal Binding`);
    }
  });

  it("red-team 68 Conv partial returns three documented converter-family x:Bind args matching Binding", async () => {
    const xItems = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, Conv|}" />'));
    const bItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, Conv|}" />'));
    for (const label of ["Converter", "ConverterParameter", "ConverterLanguage"]) {
      const xDoc = docOf(xItems, label);
      const bDoc = docOf(bItems, label);
      assertBindingDoc(xDoc, label, `x:Bind Conv partial ${label}`);
      assert.strictEqual(xDoc, bDoc, `Conv partial ${label} should match Binding; x=${JSON.stringify(itemsOf(xItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
    }
  });

  it("red-team 68 Mod partial returns documented Mode matching Binding", async () => {
    const xItems = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, Mod|}" />'));
    const bItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, Mod|}" />'));
    const xDoc = docOf(xItems, "Mode");
    const bDoc = docOf(bItems, "Mode");
    assertBindingDoc(xDoc, "Mode", "x:Bind Mod partial");
    assert.strictEqual(xDoc, bDoc, `Mode partial docs diverged; x=${JSON.stringify(itemsOf(xItems, "Mode"))} b=${JSON.stringify(itemsOf(bItems, "Mode"))}`);
  });

  it("red-team 68 BindBack is x:Bind-only with curated TwoWay write-back documentation", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, BindB|}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, BindB|}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    const doc = docOf(xItems, X_BIND_ONLY);
    assert.ok(doc.length > 0, `buffer=${JSON.stringify(xBuffer)} caret=${caretOffset(xBuffer)} expected BindBack doc; hits=${JSON.stringify(itemsOf(xItems, X_BIND_ONLY))}`);
    assert.match(doc, /write|back|two.?way/i, `BindBack doc should mention writing back in TwoWay binding; got ${JSON.stringify(doc)}`);
    assertSanitized(doc, "BindBack");
    assert.strictEqual(docOf(bItems, X_BIND_ONLY), "", `classic Binding must not offer documented BindBack; buffer=${JSON.stringify(bBuffer)} hits=${JSON.stringify(itemsOf(bItems, X_BIND_ONLY))}`);
  });

  it("red-team 68 classic Binding arg names remain documented for all seven overlap labels", async () => {
    const items = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    for (const label of OVERLAPPING) {
      assertBindingDoc(docOf(items, label), label, `classic Binding regression ${label}`);
    }
    assert.strictEqual(docOf(items, X_BIND_ONLY), "", `classic Binding unexpectedly documents BindBack; hits=${JSON.stringify(itemsOf(items, X_BIND_ONLY))}`);
  });

  it("red-team 68 x:Bind docs are sanitized for every curated name", async () => {
    const items = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    for (const label of ALL_X_BIND_ARGS) {
      const d = docOf(items, label);
      assert.ok(d.length > 0, `expected doc to sanitation-check for ${label}`);
      assertSanitized(d, `x:Bind sanitation ${label}`);
    }
  });

  it("red-team 68 malformed unterminated x:Bind argument list returns stable documented items", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |');
    const items = await docsFor(buffer);
    assert.ok(Array.isArray(items), `completionDocsAt should return an array for malformed buffer at caret ${caretOffset(buffer)}`);
    assertBindingDoc(docOf(items, "Mode"), "Mode", `malformed x:Bind buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
    assertBindingDoc(docOf(items, "Converter"), "Converter", `malformed x:Bind buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
  });

  it("red-team 68 whitespace variants do not drop borrowed x:Bind docs", async () => {
    const variants = [
      page('<TextBlock Text="{x:Bind GreetingText,\t|}" />'),
      page('<TextBlock Text="{x:Bind GreetingText,\n      |}" />'),
      page('<TextBlock Text="{x:Bind   GreetingText  ,  Mod|}" />'),
    ];
    for (const buffer of variants) {
      const items = await docsFor(buffer);
      assertBindingDoc(docOf(items, "Mode"), "Mode", `whitespace variant buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
    }
  });

  it("red-team 68 repeated identical x:Bind completion request yields deterministic docs", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const first = await docsFor(buffer);
    const second = await docsFor(buffer);
    for (const label of ALL_X_BIND_ARGS) {
      const a = docOf(first, label);
      const b = docOf(second, label);
      assert.ok(a.length > 0, `determinism probe must exercise documented ${label}`);
      assert.strictEqual(a, b, `${label} docs changed across identical requests: first=${JSON.stringify(a)} second=${JSON.stringify(b)}`);
    }
  });

  it("red-team 68 RelativeSource Mode does not borrow Binding/x:Bind Mode documentation", async () => {
    const bindingModeDoc = docOf(await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, Mod|}" />')), "Mode");
    const xBindModeDoc = docOf(await docsFor(page('<TextBlock Text="{x:Bind GreetingText, Mod|}" />')), "Mode");
    const relBuffer = page('<TextBlock Text="{Binding RelativeSource={RelativeSource Mod|}, Path=Content}" />');
    const relItems = await docsFor(relBuffer);
    const relModeDoc = docOf(relItems, "Mode");
    assertBindingDoc(bindingModeDoc, "Mode", "Binding Mode baseline");
    assert.strictEqual(xBindModeDoc, bindingModeDoc, "x:Bind Mode baseline should equal Binding Mode");
    assert.ok(relModeDoc.length > 0, `RelativeSource Mode should be resolved by its own reflection path; buffer=${JSON.stringify(relBuffer)} caret=${caretOffset(relBuffer)} hits=${JSON.stringify(itemsOf(relItems, "Mode"))}`);
    assert.notStrictEqual(relModeDoc, bindingModeDoc, `RelativeSource Mode leaked Binding.Mode docs; relative=${JSON.stringify({ detail: detailOf(relItems, "Mode"), documentation: relModeDoc })} binding=${JSON.stringify(bindingModeDoc)}`);
  });

  it("red-team 68 StaticResource and ThemeResource do not surface documented Binding arg names", async () => {
    const bindingItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const resourceBuffers = [
      page('<Grid Background="{StaticResource |}" />'),
      page('<Grid Background="{ThemeResource |}" />'),
    ];
    for (const buffer of resourceBuffers) {
      const items = await docsFor(buffer);
      for (const label of OVERLAPPING) {
        assertNoDocumentedBindingArg(items, label, docOf(bindingItems, label), `resource buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
      }
    }
  });

  it("red-team 68 TemplateBinding does not surface documented Binding arg names", async () => {
    const bindingItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const buffer = page('<ControlTemplate TargetType="Button">\n    <Border Width="{TemplateBinding |}" />\n  </ControlTemplate>');
    const items = await docsFor(buffer);
    for (const label of OVERLAPPING) {
      assertNoDocumentedBindingArg(items, label, docOf(bindingItems, label), `TemplateBinding buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
    }
  });

  it("red-team 68 partial TargetNull and UpdateSourceTrigger are documented and equal Binding", async () => {
    const cases = [
      { label: "TargetNullValue", partial: "TargetN" },
      { label: "UpdateSourceTrigger", partial: "Update" },
    ];
    for (const c of cases) {
      const xItems = await docsFor(page(`<TextBlock Text="{x:Bind GreetingText, ${c.partial}|}" />`));
      const bItems = await docsFor(page(`<TextBlock Text="{Binding Path=GreetingText, ${c.partial}|}" />`));
      const xDoc = docOf(xItems, c.label);
      const bDoc = docOf(bItems, c.label);
      assertBindingDoc(xDoc, c.label, `x:Bind partial ${c.partial}`);
      assert.strictEqual(xDoc, bDoc, `${c.label} partial doc mismatch; x=${JSON.stringify(itemsOf(xItems, c.label))} b=${JSON.stringify(itemsOf(bItems, c.label))}`);
    }
  });

  it("red-team 68 x:Bind path position does not prematurely surface documented Binding arg names", async () => {
    const bindingItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const pathBuffer = page('<TextBlock Text="{x:Bind |}" />');
    const pathItems = await docsFor(pathBuffer);
    for (const label of OVERLAPPING) {
      assertNoDocumentedBindingArg(pathItems, label, docOf(bindingItems, label), `x:Bind path-position buffer=${JSON.stringify(pathBuffer)} caret=${caretOffset(pathBuffer)}`);
    }
  });

  // Later argument positions use a distinct classifier path.
  it("red-team 68 SECOND-comma argument position still documents remaining x:Bind args, equal to Binding", async () => {
    const xItems = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, Mode=OneWay, |}" />'));
    const bItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    for (const label of ["Converter", "FallbackValue", "TargetNullValue"]) {
      const xDoc = docOf(xItems, label);
      assertBindingDoc(xDoc, label, `2nd-comma x:Bind ${label}`);
      assert.strictEqual(xDoc, docOf(bItems, label), `2nd-comma x:Bind ${label} doc should equal classic Binding; hits=${JSON.stringify(itemsOf(xItems, label))}`);
    }
    const bb = docOf(xItems, X_BIND_ONLY);
    assert.match(bb, /write|back|two.?way/i, `2nd-comma BindBack curated doc; got ${JSON.stringify(bb)}`);
    assertSanitized(bb, "2nd-comma BindBack");
  });

  it("red-team 68 resource-laden multi-argument x:Bind still documents Mode and FallbackValue", async () => {
    const buffer = page('<Page.Resources><SolidColorBrush x:Key="C" Color="Red" /></Page.Resources>\n  <TextBlock Text="{x:Bind GreetingText, Converter={StaticResource C}, ConverterParameter=abc, |}" />');
    const items = await docsFor(buffer);
    assertBindingDoc(docOf(items, "Mode"), "Mode", `resource-laden multi-arg buffer=${JSON.stringify(buffer)}`);
    assertBindingDoc(docOf(items, "FallbackValue"), "FallbackValue", `resource-laden multi-arg buffer=${JSON.stringify(buffer)}`);
  });
});
