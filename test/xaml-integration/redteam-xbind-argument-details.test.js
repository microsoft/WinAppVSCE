"use strict";

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
const ALL_X_BIND_ARGS = [
  "Mode",
  "Converter",
  "ConverterParameter",
  "ConverterLanguage",
  "FallbackValue",
  "TargetNullValue",
  X_BIND_ONLY,
  "UpdateSourceTrigger",
];

function caretOffset(buffer) {
  return buffer.indexOf("|");
}

function itemsOf(items, label) {
  return items.filter((i) => i.label === label).map((i) => ({
    detail: i.detail || "",
    documentation: i.documentation || "",
  }));
}

function serverItemsOf(items, label) {
  return itemsOf(items, label).filter((i) => i.detail.length > 0 || i.documentation.length > 0);
}

function completionItemOf(items, label) {
  return serverItemsOf(items, label)[0] || itemsOf(items, label)[0] || { detail: "", documentation: "" };
}

const detailOf = (items, label) => completionItemOf(items, label).detail || "";
const docOf = (items, label) => completionItemOf(items, label).documentation || "";

async function docsFor(buffer) {
  return h.completionDocsAt(buffer);
}

function assertPropertyDetail(detail, label, reason) {
  assert.ok(detail.length > 0, `${reason}: expected non-empty Detail for ${label}; got ${JSON.stringify(detail)}`);
  assert.match(detail, /^property\s*:\s*\S+/i, `${reason}: expected property Detail for ${label}; got ${JSON.stringify(detail)}`);
  assert.doesNotMatch(detail, /^event\s*:/i, `${reason}: ${label} must not look like an event; got ${JSON.stringify(detail)}`);
}

function assertBindingDoc(doc, label, reason) {
  assert.ok(doc.length > 0, `${reason}: expected non-empty Documentation for ${label}; got ${JSON.stringify(doc)}`);
  assert.match(doc, /gets or sets/i, `${reason}: expected Binding property prose for ${label}; got ${JSON.stringify(doc)}`);
}

function assertDetailAndDocParity(xItems, bItems, label, reason) {
  const bDetail = detailOf(bItems, label);
  const xDetail = detailOf(xItems, label);
  const bDoc = docOf(bItems, label);
  const xDoc = docOf(xItems, label);
  assertPropertyDetail(bDetail, label, `${reason} classic Binding`);
  assertPropertyDetail(xDetail, label, `${reason} x:Bind`);
  assert.strictEqual(xDetail, bDetail, `${reason}: ${label} Detail mismatch; x=${JSON.stringify(itemsOf(xItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
  assertBindingDoc(bDoc, label, `${reason} classic Binding`);
  assertBindingDoc(xDoc, label, `${reason} x:Bind`);
  assert.strictEqual(xDoc, bDoc, `${reason}: ${label} Documentation mismatch; x=${JSON.stringify(itemsOf(xItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
}

function assertNoBindingArgLeak(items, label, bindingDetail, bindingDoc, reason) {
  const hits = itemsOf(items, label);
  assert.ok(
    hits.every((i) => i.detail !== bindingDetail && i.documentation !== bindingDoc),
    `${reason}: ${label} leaked Binding arg surface; binding=${JSON.stringify({ detail: bindingDetail, documentation: bindingDoc })} hits=${JSON.stringify(hits)}`
  );
}

describe("WinUI XAML — red-team 69 (x:Bind argument-name Detail parity)", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  it("red-team 69 every overlapping x:Bind arg Detail is non-empty property-shaped and byte-identical to classic Binding", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, |}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    for (const label of OVERLAPPING) {
      const bDetail = detailOf(bItems, label);
      const xDetail = detailOf(xItems, label);
      assertPropertyDetail(bDetail, label, `classic Binding buffer=${JSON.stringify(bBuffer)} caret=${caretOffset(bBuffer)}`);
      assertPropertyDetail(xDetail, label, `x:Bind buffer=${JSON.stringify(xBuffer)} caret=${caretOffset(xBuffer)}`);
      assert.strictEqual(xDetail, bDetail, `${label} Detail must be byte-identical; x=${JSON.stringify(itemsOf(xItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
    }
  });

  it("red-team 69 adding Detail does not regress round-68 Documentation parity for all seven overlap labels", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, |}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    for (const label of OVERLAPPING) {
      const xDoc = docOf(xItems, label);
      const bDoc = docOf(bItems, label);
      assertBindingDoc(xDoc, label, `x:Bind buffer=${JSON.stringify(xBuffer)} caret=${caretOffset(xBuffer)}`);
      assertBindingDoc(bDoc, label, `classic Binding buffer=${JSON.stringify(bBuffer)} caret=${caretOffset(bBuffer)}`);
      assert.strictEqual(xDoc, bDoc, `${label} Documentation changed while adding Detail; x=${JSON.stringify(itemsOf(xItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
    }
  });

  it("red-team 69 empty x:Bind argument position offers all eight curated names with server-only detail or documentation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const items = await docsFor(buffer);
    for (const label of ALL_X_BIND_ARGS) {
      assert.ok(serverItemsOf(items, label).length > 0, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} expected server item for ${label}; hits=${JSON.stringify(itemsOf(items, label))}`);
    }
  });

  it("red-team 69 BindBack has exact curated method Detail and curated write-back Documentation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, BindB|}" />');
    const items = await docsFor(buffer);
    const detail = detailOf(items, X_BIND_ONLY);
    const doc = docOf(items, X_BIND_ONLY);
    assert.strictEqual(detail, "method", `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} expected BindBack Detail "method"; hits=${JSON.stringify(itemsOf(items, X_BIND_ONLY))}`);
    assert.ok(doc.length > 0, `buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} expected BindBack Documentation; hits=${JSON.stringify(itemsOf(items, X_BIND_ONLY))}`);
    assert.match(doc, /write|back|two.?way/i, `BindBack doc should mention TwoWay write-back; got ${JSON.stringify(doc)}`);
  });

  it("red-team 69 classic Binding does not offer a server BindBack item at empty or BindB-filtered arg positions", async () => {
    const buffers = [
      page('<TextBlock Text="{Binding Path=GreetingText, |}" />'),
      page('<TextBlock Text="{Binding Path=GreetingText, BindB|}" />'),
    ];
    for (const buffer of buffers) {
      const items = await docsFor(buffer);
      assert.strictEqual(serverItemsOf(items, X_BIND_ONLY).length, 0, `classic Binding must not offer server BindBack; buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} hits=${JSON.stringify(itemsOf(items, X_BIND_ONLY))}`);
    }
  });

  it("red-team 69 Mod partial keeps Mode Detail and Documentation equal between x:Bind and Binding", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, Mod|}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, Mod|}" />');
    assertDetailAndDocParity(await docsFor(xBuffer), await docsFor(bBuffer), "Mode", `Mod partial xBuffer=${JSON.stringify(xBuffer)} bBuffer=${JSON.stringify(bBuffer)}`);
  });

  it("red-team 69 Conv partial keeps all converter-family Details and Documentation equal to Binding", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, Conv|}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, Conv|}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    for (const label of ["Converter", "ConverterParameter", "ConverterLanguage"]) {
      assertDetailAndDocParity(xItems, bItems, label, `Conv partial ${label} xBuffer=${JSON.stringify(xBuffer)} bBuffer=${JSON.stringify(bBuffer)}`);
    }
  });

  it("red-team 69 partial TargetNullValue and UpdateSourceTrigger keep Details and Documentation equal to Binding", async () => {
    for (const c of [{ label: "TargetNullValue", partial: "TargetN" }, { label: "UpdateSourceTrigger", partial: "Update" }]) {
      const xBuffer = page(`<TextBlock Text="{x:Bind GreetingText, ${c.partial}|}" />`);
      const bBuffer = page(`<TextBlock Text="{Binding Path=GreetingText, ${c.partial}|}" />`);
      assertDetailAndDocParity(await docsFor(xBuffer), await docsFor(bBuffer), c.label, `partial ${c.partial} xBuffer=${JSON.stringify(xBuffer)} bBuffer=${JSON.stringify(bBuffer)}`);
    }
  });

  it("red-team 69 SECOND-comma x:Bind position preserves Detail for remaining args and BindBack", async () => {
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, Mode=OneWay, |}" />');
    const bBuffer = page('<TextBlock Text="{Binding Path=GreetingText, |}" />');
    const xItems = await docsFor(xBuffer);
    const bItems = await docsFor(bBuffer);
    for (const label of ["Converter", "FallbackValue", "TargetNullValue"]) {
      assertDetailAndDocParity(xItems, bItems, label, `second-comma ${label} xBuffer=${JSON.stringify(xBuffer)} bBuffer=${JSON.stringify(bBuffer)}`);
    }
    assert.strictEqual(detailOf(xItems, X_BIND_ONLY), "method", `second-comma BindBack Detail; buffer=${JSON.stringify(xBuffer)} hits=${JSON.stringify(itemsOf(xItems, X_BIND_ONLY))}`);
  });

  it("red-team 69 Bind alias has the same Details and Documentation as x:Bind and classic Binding", async () => {
    const aliasItems = await docsFor(page('<TextBlock Text="{Bind GreetingText, |}" />'));
    const xItems = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    const bItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    for (const label of OVERLAPPING) {
      assert.strictEqual(detailOf(aliasItems, label), detailOf(xItems, label), `{Bind} ${label} Detail should equal x:Bind; alias=${JSON.stringify(itemsOf(aliasItems, label))} x=${JSON.stringify(itemsOf(xItems, label))}`);
      assert.strictEqual(detailOf(aliasItems, label), detailOf(bItems, label), `{Bind} ${label} Detail should equal Binding; alias=${JSON.stringify(itemsOf(aliasItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
      assert.strictEqual(docOf(aliasItems, label), docOf(bItems, label), `{Bind} ${label} Documentation should equal Binding; alias=${JSON.stringify(itemsOf(aliasItems, label))} b=${JSON.stringify(itemsOf(bItems, label))}`);
    }
    assert.strictEqual(detailOf(aliasItems, X_BIND_ONLY), "method", `{Bind} BindBack Detail should be curated method; hits=${JSON.stringify(itemsOf(aliasItems, X_BIND_ONLY))}`);
  });

  it("red-team 69 repeated identical x:Bind requests are deterministic for Detail and Documentation", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |}" />');
    const first = await docsFor(buffer);
    const second = await docsFor(buffer);
    for (const label of ALL_X_BIND_ARGS) {
      const a = completionItemOf(first, label);
      const b = completionItemOf(second, label);
      assert.ok(a.detail.length > 0, `determinism must exercise Detail for ${label}; first=${JSON.stringify(itemsOf(first, label))}`);
      assert.strictEqual(a.detail, b.detail, `${label} Detail changed across identical requests; first=${JSON.stringify(a)} second=${JSON.stringify(b)}`);
      assert.strictEqual(a.documentation, b.documentation, `${label} Documentation changed across identical requests; first=${JSON.stringify(a)} second=${JSON.stringify(b)}`);
    }
  });

  it("red-team 69 malformed unterminated x:Bind argument list still returns intact Details", async () => {
    const buffer = page('<TextBlock Text="{x:Bind GreetingText, |');
    const items = await docsFor(buffer);
    assert.ok(Array.isArray(items), `completionDocsAt should return an array for malformed buffer at caret ${caretOffset(buffer)}`);
    for (const label of ["Mode", "Converter"]) {
      assertPropertyDetail(detailOf(items, label), label, `malformed buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)} hits=${JSON.stringify(itemsOf(items, label))}`);
    }
    assert.strictEqual(detailOf(items, X_BIND_ONLY), "method", `malformed BindBack Detail; buffer=${JSON.stringify(buffer)} hits=${JSON.stringify(itemsOf(items, X_BIND_ONLY))}`);
  });

  it("red-team 69 tab and newline whitespace variants do not drop x:Bind Details", async () => {
    const variants = [
      { buffer: page('<TextBlock Text="{x:Bind GreetingText,\t|}" />'), label: "Mode" },
      { buffer: page('<TextBlock Text="{x:Bind GreetingText,\n      |}" />'), label: "Mode" },
      { buffer: page('<TextBlock Text="{x:Bind   GreetingText  ,  Conv|}" />'), label: "Converter" },
    ];
    for (const v of variants) {
      const items = await docsFor(v.buffer);
      assertPropertyDetail(detailOf(items, v.label), v.label, `whitespace buffer=${JSON.stringify(v.buffer)} caret=${caretOffset(v.buffer)} hits=${JSON.stringify(itemsOf(items, v.label))}`);
    }
  });

  it("red-team 69 RelativeSource Mode keeps its own Detail instead of leaking BindingMode", async () => {
    const bindingBuffer = page('<TextBlock Text="{Binding Path=GreetingText, Mod|}" />');
    const xBuffer = page('<TextBlock Text="{x:Bind GreetingText, Mod|}" />');
    const relBuffer = page('<TextBlock Text="{Binding RelativeSource={RelativeSource Mod|}, Path=Content}" />');
    const bindingItems = await docsFor(bindingBuffer);
    const xItems = await docsFor(xBuffer);
    const relItems = await docsFor(relBuffer);
    const bindingDetail = detailOf(bindingItems, "Mode");
    const relDetail = detailOf(relItems, "Mode");
    assertPropertyDetail(bindingDetail, "Mode", `Binding baseline buffer=${JSON.stringify(bindingBuffer)} caret=${caretOffset(bindingBuffer)}`);
    assert.strictEqual(detailOf(xItems, "Mode"), bindingDetail, `x:Bind Mode baseline should equal Binding Mode; x=${JSON.stringify(itemsOf(xItems, "Mode"))} b=${JSON.stringify(itemsOf(bindingItems, "Mode"))}`);
    assertPropertyDetail(relDetail, "Mode", `RelativeSource buffer=${JSON.stringify(relBuffer)} caret=${caretOffset(relBuffer)} hits=${JSON.stringify(itemsOf(relItems, "Mode"))}`);
    assert.notStrictEqual(relDetail, bindingDetail, `RelativeSource leaked Binding.Mode Detail; relative=${JSON.stringify(itemsOf(relItems, "Mode"))} binding=${JSON.stringify(itemsOf(bindingItems, "Mode"))}`);
  });

  it("red-team 69 StaticResource and ThemeResource do not surface detailed or documented Binding arg names", async () => {
    const bindingItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const resourceBuffers = [
      page('<Grid Background="{StaticResource |}" />'),
      page('<Grid Background="{ThemeResource |}" />'),
    ];
    for (const buffer of resourceBuffers) {
      const items = await docsFor(buffer);
      for (const label of OVERLAPPING) {
        assertNoBindingArgLeak(items, label, detailOf(bindingItems, label), docOf(bindingItems, label), `resource buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
      }
    }
  });

  it("red-team 69 TemplateBinding does not surface detailed or documented Binding arg names", async () => {
    const bindingItems = await docsFor(page('<TextBlock Text="{Binding Path=GreetingText, |}" />'));
    const buffer = page('<ControlTemplate TargetType="Button">\n    <Border Width="{TemplateBinding |}" />\n  </ControlTemplate>');
    const items = await docsFor(buffer);
    for (const label of OVERLAPPING) {
      assertNoBindingArgLeak(items, label, detailOf(bindingItems, label), docOf(bindingItems, label), `TemplateBinding buffer=${JSON.stringify(buffer)} caret=${caretOffset(buffer)}`);
    }
  });

  // Pin exact strings to catch DescribeMember formatting changes.
  it("red-team 69 hardcoded oracle: exact Detail strings for the curated x:Bind arg names", async () => {
    const xb = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, |}" />'));
    assert.strictEqual(detailOf(xb, "Mode"), "property : BindingMode", `Mode detail oracle; hits=${JSON.stringify(itemsOf(xb, "Mode"))}`);
    assert.strictEqual(detailOf(xb, "UpdateSourceTrigger"), "property : UpdateSourceTrigger", `UpdateSourceTrigger detail oracle; hits=${JSON.stringify(itemsOf(xb, "UpdateSourceTrigger"))}`);
    assert.strictEqual(detailOf(xb, "Converter"), "property : IValueConverter", `Converter detail oracle; hits=${JSON.stringify(itemsOf(xb, "Converter"))}`);
    assert.strictEqual(detailOf(xb, "ConverterLanguage"), "property : string", `ConverterLanguage detail oracle; hits=${JSON.stringify(itemsOf(xb, "ConverterLanguage"))}`);
    assert.strictEqual(detailOf(xb, X_BIND_ONLY), "method", `BindBack curated detail oracle; hits=${JSON.stringify(itemsOf(xb, X_BIND_ONLY))}`);
  });

  // Enum argument values use enum detail, not argument-name detail.
  it("red-team 69 round-65 enum arg-VALUE completion Detail is unperturbed by the arg-NAME Detail change", async () => {
    const vals = await docsFor(page('<TextBlock Text="{x:Bind GreetingText, Mode=|}" />'));
    const oneWay = vals.find((i) => i.label === "OneWay");
    assert.ok(oneWay, `Mode= must still complete BindingMode value OneWay (round 65 intact); labels=${JSON.stringify(vals.map((i) => i.label))}`);
    const d = oneWay.detail || "";
    assert.doesNotMatch(d, /^property\s*:/i, `enum value Detail must not read like a property; got ${JSON.stringify(d)}`);
    assert.notStrictEqual(d, "method", `enum value Detail must not be the BindBack curated 'method'; got ${JSON.stringify(d)}`);
  });
});
