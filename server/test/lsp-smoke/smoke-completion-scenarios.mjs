export async function runCompletionScenarios(ctx) {
  const {
    fail, xamlUri, XAML, NS, pageRes, pageCls, ev, docSymbols, validateDoc,
    completeWith, completeItemsWith, hoverAt, definitionWith, codeActionAtCaret,
    readFileSync, writeFileSync, pathToFileURL, dirname, resolve, join,
    mkdtempSync, rmSync, tmpdir, send, waitFor, responseFor,
    colors, swatch, near, offsetToPosition,
  } = ctx;

  // 430) xmlns declaration VALUE completion (round 61) — an empty/partial xmlns value offers the well-known
  //      framework URIs plus the using: scheme (VS-parity authoring aid), each replacing the whole value.
  const PRES = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
  const XAMLNS = "http://schemas.microsoft.com/winfx/2006/xaml";
  const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  const xvEmpty = await completeItemsWith(430, `<Page ${NS} xmlns:zzz="|">\n  <Grid />\n</Page>`, "xmlns-value-empty");
  const xvLabels = xvEmpty.map((i) => i.label);
  for (const want of [PRES, XAMLNS, MC, "using:"]) {
    if (!xvLabels.includes(want)) {
      fail(`empty xmlns value must offer '${want}' (got ${JSON.stringify(xvLabels.filter((l) => l.startsWith("http") || l === "using:"))})`);
    }
  }
  const presItem = xvEmpty.find((i) => i.label === PRES);
  if (presItem.detail !== "WinUI presentation namespace") {
    fail(`presentation URI should carry its detail (got ${JSON.stringify(presItem.detail)})`);
  }
  const presNewText = presItem.textEdit ? presItem.textEdit.newText : presItem.insertText;
  if (presNewText !== PRES) {
    fail(`xmlns value item must replace the whole value with the URI (got ${JSON.stringify(presNewText)})`);
  }
  // Scheme still being typed -> the using: scheme item is offered (hands off to CLR-namespace completion).
  const xvUsing = (await completeItemsWith(431, `<Page ${NS} xmlns:zzz="usin|">\n  <Grid />\n</Page>`, "xmlns-value-using")).map((i) => i.label);
  if (!xvUsing.includes("using:")) {
    fail(`partial 'usin' must offer the using: scheme (got ${JSON.stringify(xvUsing)})`);
  }
  // A partial URI filters on the whole value: the presentation prefix matches the WinUI URI but not the mc URI.
  const xvHttp = (await completeItemsWith(432, `<Page ${NS} xmlns:zzz="http://schemas.microsoft.com/winfx|">\n  <Grid />\n</Page>`, "xmlns-value-partial")).map((i) => i.label);
  if (!xvHttp.some((l) => l === PRES) || xvHttp.some((l) => l === MC)) {
    fail(`partial winfx URI must match the WinUI URIs but not the openxmlformats mc URI (got ${JSON.stringify(xvHttp.filter((l) => l.startsWith("http")))})`);
  }
  console.log(`[ok] xmlns value completion -> framework URIs + using: scheme, whole-value replacement, prefix-filtered`);

  // 433-436) RelativePanel alignment attached-property completion (round 62) — properties like
  //      RelativePanel.RightOf reference an x:Name'd sibling, so they complete with the in-scope element
  //      names (like Storyboard.TargetName); the boolean *WithPanel variants stay bool (True/False).
  const rpNames = (inner, id, label) =>
    completeWith(id, `<Page ${NS}>\n  <RelativePanel>\n    <TextBox x:Name="FirstBox" />\n    <TextBox x:Name="SecondBox" />\n    <Button x:Name="GoButton" ${inner} />\n  </RelativePanel>\n</Page>`, label);

  const rpRightOf = await rpNames('RelativePanel.RightOf="|"', 433, "relativepanel-rightof");
  for (const want of ["FirstBox", "SecondBox"]) {
    if (!rpRightOf.includes(want)) {
      fail(`RelativePanel.RightOf must offer the in-scope name '${want}' (got ${JSON.stringify(rpRightOf)})`);
    }
  }
  const rpFilter = await rpNames('RelativePanel.RightOf="First|"', 434, "relativepanel-filter");
  if (!rpFilter.includes("FirstBox") || rpFilter.includes("SecondBox")) {
    fail(`RelativePanel.RightOf partial 'First' must match FirstBox but not SecondBox (got ${JSON.stringify(rpFilter)})`);
  }
  const rpAlignTop = await rpNames('RelativePanel.AlignTopWith="|"', 435, "relativepanel-aligntop");
  if (!rpAlignTop.includes("FirstBox")) {
    fail(`RelativePanel.AlignTopWith must also offer in-scope names (got ${JSON.stringify(rpAlignTop)})`);
  }
  const rpPanelBool = await rpNames('RelativePanel.AlignLeftWithPanel="|"', 436, "relativepanel-panelbool");
  if (!rpPanelBool.includes("True") || !rpPanelBool.includes("False")) {
    fail(`RelativePanel.AlignLeftWithPanel is boolean -> should offer True/False (got ${JSON.stringify(rpPanelBool)})`);
  }
  if (rpPanelBool.includes("FirstBox")) {
    fail(`the boolean *WithPanel variant must NOT offer element names (got ${JSON.stringify(rpPanelBool)})`);
  }
  console.log(`[ok] RelativePanel alignment completion -> in-scope x:Names (filtered); *WithPanel stays boolean`);

  // 21g) classic {Binding} member-path completion (round 51) — inside a DataTemplate the design-time
  //      DataContext is the template's x:DataType, so {Binding} completes that type's members; at the
  //      page root the DataContext type is unknown, so {Binding} offers no project members.
  const cbTemplate =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <ListView>\n    <ListView.ItemTemplate>\n` +
    `      <DataTemplate x:DataType="local:SmokePage">\n` +
    `        <TextBlock Text="{Binding Gree|}" />\n` +
    `      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>\n</Page>`;
  const cbLabels = await completeWith(397, cbTemplate, "classic-binding-template");
  if (!cbLabels.includes("GreetingText")) {
    fail(`classic {Binding} in a DataTemplate must complete the x:DataType member 'GreetingText' (got ${JSON.stringify(cbLabels)})`);
  }

  const cbEmpty =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <TextBlock Text="{Binding |}" />\n</Page>`;
  const cbEmptyLabels = await completeWith(398, cbEmpty, "classic-binding-page-root");
  if (cbEmptyLabels.includes("GreetingText")) {
    fail(`classic {Binding} at the page root must NOT leak x:Class members (DataContext is unknown; got ${JSON.stringify(cbEmptyLabels)})`);
  }

  // Round 76: an ElementName redirect inside a DataTemplate roots the path at the NAMED element's type,
  // overriding the template's x:DataType — so it completes that element's members, not the x:DataType's.
  const cbRedirect =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <ListView>\n    <ListView.ItemTemplate>\n` +
    `      <DataTemplate x:DataType="local:SmokePage">\n` +
    `        <StackPanel>\n` +
    `          <TextBox x:Name="Root" />\n` +
    `          <TextBlock Text="{Binding ElementName=Root, Path=|}" />\n` +
    `        </StackPanel>\n` +
    `      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>\n</Page>`;
  const cbRedirectLabels = await completeWith(399, cbRedirect, "classic-binding-redirect");
  for (const want of ["Text", "IsEnabled"]) {
    if (!cbRedirectLabels.includes(want)) {
      fail(`{Binding ElementName=Root} inside a DataTemplate should offer the named TextBox member '${want}' (got ${JSON.stringify(cbRedirectLabels.slice(0, 40))})`);
    }
  }
  if (cbRedirectLabels.includes("GreetingText")) {
    fail(`{Binding ElementName=Root} must root at the named element, NOT the template x:DataType (leaked 'GreetingText')`);
  }
  console.log(`[ok] classic {Binding}: DataTemplate -> x:DataType members; ElementName redirect -> named element wins over x:DataType`);

  // 21h) classic {Binding} page-level rooting via a design-time DataContext (round 52) — an ancestor's
  //      d:DataContext="{d:DesignInstance local:SmokePage}" gives the editor the DataContext type, so a
  //      page-level {Binding} completes that type's members. A nearer DataTemplate x:DataType still wins.
  const diNs =
    `<Page ${NS} xmlns:d="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="d" x:Class="SmokeFixture.SmokePage">`;

  const diBody =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diLabels = await completeWith(400, diBody, "design-instance-binding");
  if (!diLabels.includes("GreetingText")) {
    fail(`d:DataContext {d:DesignInstance local:SmokePage} must root {Binding} at SmokePage -> GreetingText (got ${JSON.stringify(diLabels)})`);
  }

  const diTypeEq =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance Type=local:SmokePage, IsDesignTimeCreatable=True}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diTypeEqLabels = await completeWith(401, diTypeEq, "design-instance-type-eq");
  if (!diTypeEqLabels.includes("GreetingText")) {
    fail(`d:DesignInstance Type=local:SmokePage (named form) must also root at SmokePage (got ${JSON.stringify(diTypeEqLabels)})`);
  }

  const diShadow =
    `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:SmokePage}">\n` +
    `    <ListView>\n      <ListView.ItemTemplate>\n        <DataTemplate x:DataType="x:String">\n` +
    `          <TextBlock Text="{Binding Gree|}" />\n` +
    `        </DataTemplate>\n      </ListView.ItemTemplate>\n    </ListView>\n  </Grid>\n</Page>`;
  const diShadowLabels = await completeWith(402, diShadow, "design-instance-shadow");
  if (diShadowLabels.includes("GreetingText")) {
    fail(`a nearer DataTemplate x:DataType must shadow the outer d:DataContext (String has no GreetingText; got ${JSON.stringify(diShadowLabels)})`);
  }

  // The DesignInstance extension's OWN prefix must resolve to a design-time namespace, not just end in
  // ":DesignInstance". An undeclared {zzz:DesignInstance …} is not the hint and must not root the Binding.
  const diBadPrefix =
    `${diNs}\n  <Grid d:DataContext="{zzz:DesignInstance local:SmokePage}">\n` +
    `    <TextBlock Text="{Binding Gree|}" />\n  </Grid>\n</Page>`;
  const diBadPrefixLabels = await completeWith(403, diBadPrefix, "design-instance-bad-prefix");
  if (diBadPrefixLabels.includes("GreetingText")) {
    fail(`an undeclared DesignInstance extension prefix must not root {Binding} at SmokePage (got ${JSON.stringify(diBadPrefixLabels)})`);
  }
  console.log(`[ok] design-time {Binding}: d:DataContext {d:DesignInstance} (positional + Type=) roots at SmokePage; inner x:DataType shadows; foreign extension prefix rejected`);

  // x:DataType is recognized only under the reserved x prefix (consistent with the validator + F12 sites).
  // A DataTemplate whose DataType uses a FOREIGN prefix is not an x:DataType, so bindings inside get no root.
  const xdtControl =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:SmokePage">\n` +
    `      <TextBlock Text="{x:Bind Gree|}" />\n` +
    `    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtControlLabels = await completeWith(404, xdtControl, "xdatatype-x-prefix");
  if (!xdtControlLabels.includes("GreetingText")) {
    fail(`x:DataType (reserved x prefix) must root x:Bind at SmokePage -> GreetingText (got ${JSON.stringify(xdtControlLabels)})`);
  }
  const xdtForeign =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate zzz:DataType="local:SmokePage">\n` +
    `      <TextBlock Text="{x:Bind Gree|}" />\n` +
    `    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtForeignLabels = await completeWith(405, xdtForeign, "xdatatype-foreign-prefix");
  if (xdtForeignLabels.includes("GreetingText")) {
    fail(`a foreign-prefix DataType must NOT be treated as x:DataType (expected no GreetingText; got ${JSON.stringify(xdtForeignLabels)})`);
  }
  console.log(`[ok] x:DataType prefix: reserved x roots x:Bind in a template; foreign-prefix DataType is not x:DataType`);

  // Round 54: x:DataType="|" completes type names (the design-time item type), like TargetType.
  const xdtLocal =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtLocalLabels = await completeWith(406, xdtLocal, "xdatatype-value-local");
  if (!xdtLocalLabels.includes("SmokePage")) {
    fail(`x:DataType="local:|" must complete project types -> SmokePage (got ${JSON.stringify(xdtLocalLabels)})`);
  }

  const xdtFilter =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="local:Smo|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtFilterLabels = await completeWith(407, xdtFilter, "xdatatype-value-filter");
  if (!xdtFilterLabels.includes("SmokePage")) {
    fail(`x:DataType="local:Smo|" must filter to SmokePage (got ${JSON.stringify(xdtFilterLabels)})`);
  }

  // Empty prefix resolves the default (WinUI presentation) namespace -> framework types are offered.
  const xdtDefault =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="Butt|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xdtDefaultLabels = await completeWith(408, xdtDefault, "xdatatype-value-default-ns");
  if (!xdtDefaultLabels.includes("Button")) {
    fail(`x:DataType="Butt|" must complete default-namespace framework types -> Button (got ${JSON.stringify(xdtDefaultLabels)})`);
  }

  // Guard: only x:DataType gets type completion; another x: directive (x:Name) must not.
  const xnameGuard =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:Name="local:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xnameGuardLabels = await completeWith(409, xnameGuard, "xname-value-no-types");
  if (xnameGuardLabels.includes("SmokePage")) {
    fail(`x:Name value must NOT get type completion (only x:DataType); got ${JSON.stringify(xnameGuardLabels)}`);
  }
  console.log(`[ok] x:DataType value: completes project (local:SmokePage) + framework (Button) types with prefix/partial filtering; other x: directives unaffected`);

  // Round 55: type-name completion offers the XAML intrinsic aliases (x:String, x:Boolean, …) when the
  // reference prefix resolves to the XAML language namespace — cross-cutting to every type-reference site.
  const xiEmpty =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="x:|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiEmptyLabels = await completeWith(410, xiEmpty, "intrinsic-xdatatype-empty");
  for (const alias of ["String", "Boolean", "Int32", "Object"]) {
    if (!xiEmptyLabels.includes(alias)) {
      fail(`x:DataType="x:|" must offer the XAML intrinsic ${alias} (got ${JSON.stringify(xiEmptyLabels)})`);
    }
  }

  const xiFilter =
    `${diNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="x:Str|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiFilterLabels = await completeWith(411, xiFilter, "intrinsic-xdatatype-filter");
  if (!xiFilterLabels.includes("String") || xiFilterLabels.includes("Boolean")) {
    fail(`x:DataType="x:Str|" must filter intrinsics to String only (got ${JSON.stringify(xiFilterLabels)})`);
  }

  // Cross-cutting + Round 56: TargetType uses the CLASS-ONLY type list, so intrinsics are kind-filtered
  // to match — reference-type aliases (String/Object/Type/Uri) are offered, value-type aliases
  // (Int32/Boolean/Double/…) are NOT, exactly as a value-type CLR struct would be filtered out here.
  const xiTarget = `${diNs}\n  <Style TargetType="x:|" />\n</Page>`;
  const xiTargetLabels = await completeWith(412, xiTarget, "intrinsic-targettype");
  for (const refAlias of ["String", "Object", "Type", "Uri"]) {
    if (!xiTargetLabels.includes(refAlias)) {
      fail(`TargetType="x:|" must offer the reference-type intrinsic ${refAlias} (got ${JSON.stringify(xiTargetLabels)})`);
    }
  }
  for (const valAlias of ["Int32", "Boolean", "Double"]) {
    if (xiTargetLabels.includes(valAlias)) {
      fail(`TargetType="x:|" (class-only) must NOT offer the value-type intrinsic ${valAlias} (got ${JSON.stringify(xiTargetLabels)})`);
    }
  }

  // The intrinsics are keyed by the resolved URI, not the literal "x" prefix: a custom prefix mapped to
  // the XAML language namespace offers them too.
  const xiCustomNs =
    `<Page ${NS} xmlns:d="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="d" x:Class="SmokeFixture.SmokePage">`;
  const xiCustom =
    `${xiCustomNs}\n  <ListView><ListView.ItemTemplate>\n` +
    `    <DataTemplate x:DataType="sys:Str|">\n` +
    `      <TextBlock />\n    </DataTemplate>\n  </ListView.ItemTemplate></ListView>\n</Page>`;
  const xiCustomLabels = await completeWith(413, xiCustom, "intrinsic-custom-prefix");
  if (!xiCustomLabels.includes("String")) {
    fail(`a custom prefix mapped to the XAML URI must offer intrinsics -> String (got ${JSON.stringify(xiCustomLabels)})`);
  }

  // Round 56: the kind-permissive callers ({x:Type}/{x:Static} owner, x:DataType) KEEP the value-type
  // intrinsics — a {x:Type x:Int32} / x:DataType="x:Int32" is valid, so the filter must not over-prune.
  const xiTypeArg = `${diNs}\n  <Button Tag="{x:Type x:|}" />\n</Page>`;
  const xiTypeArgLabels = await completeWith(414, xiTypeArg, "intrinsic-xtype-valuetypes");
  for (const alias of ["String", "Int32", "Boolean"]) {
    if (!xiTypeArgLabels.includes(alias)) {
      fail(`{x:Type x:|} (all-kinds) must still offer the intrinsic ${alias} incl. value types (got ${JSON.stringify(xiTypeArgLabels)})`);
    }
  }
  console.log(`[ok] XAML intrinsics: full set in x:DataType/{x:Type} (all kinds); TargetType kind-filtered to reference types only (round 56); partial-filtered; keyed by the resolved XAML URI (custom prefix works)`);

  // Round 57: {d:DesignInstance …} type-argument completion — the AUTHORING counterpart to the round-52
  // CONSUMPTION cases (400-403). The TYPE arg (positional or Type=) completes type names; the extension
  // prefix must resolve to a design-time namespace (foreign/undeclared → nothing).
  const diPos = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance local:|}" />\n</Page>`;
  const diPosLabels = await completeWith(415, diPos, "designinstance-positional-type");
  if (!diPosLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance local:|} must complete project types -> SmokePage (got ${JSON.stringify(diPosLabels)})`);
  }

  const diTypeArg = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance Type=local:Smo|}" />\n</Page>`;
  const diTypeArgLabels = await completeWith(416, diTypeArg, "designinstance-type-eq-completion");
  if (!diTypeArgLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance Type=local:Smo|} must filter to SmokePage (got ${JSON.stringify(diTypeArgLabels)})`);
  }

  // Type= after a leading bool arg is still found (top-level comma splitting).
  const diAfterArg = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|}" />\n</Page>`;
  const diAfterArgLabels = await completeWith(417, diAfterArg, "designinstance-type-after-arg");
  if (!diAfterArgLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Smo|} must still complete SmokePage (got ${JSON.stringify(diAfterArgLabels)})`);
  }

  // A custom prefix mapped to the SAME design-time URI also works (gate is by resolved URI, not literal "d").
  const diCustomNs =
    `<Page ${NS} xmlns:dd="http://schemas.microsoft.com/expression/blend/2008" ` +
    `xmlns:local="using:SmokeFixture" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
    `mc:Ignorable="dd" x:Class="SmokeFixture.SmokePage">`;
  const diCustom = `${diCustomNs}\n  <Grid dd:DataContext="{dd:DesignInstance local:|}" />\n</Page>`;
  const diCustomLabels = await completeWith(418, diCustom, "designinstance-custom-design-prefix");
  if (!diCustomLabels.includes("SmokePage")) {
    fail(`{dd:DesignInstance local:|} (custom prefix on the blend/2008 URI) must complete SmokePage (got ${JSON.stringify(diCustomLabels)})`);
  }

  // Gate: a foreign/undeclared extension prefix offers NOTHING (design-time namespace gate).
  const diForeign = `${diNs}\n  <Grid d:DataContext="{zzz:DesignInstance local:|}" />\n</Page>`;
  const diForeignLabels = await completeWith(419, diForeign, "designinstance-foreign-prefix");
  if (diForeignLabels.includes("SmokePage")) {
    fail(`{zzz:DesignInstance local:|} (undeclared prefix) must offer no type completion (got ${JSON.stringify(diForeignLabels)})`);
  }

  // The wrapped {d:DesignInstance {x:Type local:Smo|}} form completes via the inner {x:Type} re-rooting.
  const diWrapped = `${diNs}\n  <Grid d:DataContext="{d:DesignInstance {x:Type local:Smo|}}" />\n</Page>`;
  const diWrappedLabels = await completeWith(420, diWrapped, "designinstance-wrapped-xtype");
  if (!diWrappedLabels.includes("SmokePage")) {
    fail(`{d:DesignInstance {x:Type local:Smo|}} must complete SmokePage via the inner {x:Type} (got ${JSON.stringify(diWrappedLabels)})`);
  }
  console.log(`[ok] {d:DesignInstance …} type-arg completion: positional + Type= (incl. after another arg) complete project types; custom design-time prefix works by URI; foreign prefix gated to nothing; wrapped {x:Type} re-roots (round 57)`);

  // Round 58: XAML intrinsic aliases offered as ELEMENTS (<x:String>, <x:Double>, …) — the element-name counterpart to rounds 55/56 (which offered them in type-REFERENCE positions). ALL 14 are offered (incl. value types) since XAML supports instantiating the intrinsic value types as elements; the gate is the resolved XAML language URI, and the existing content-type assignability filter still constrains typed collection property elements.
  const xelEmpty = pageRes("<x:|");
  const xelEmptyLabels = await completeWith(421, xelEmpty, "intrinsic-element-empty");
  for (const alias of ["String", "Int32", "Double", "Boolean", "Object", "TimeSpan", "Uri"]) {
    if (!xelEmptyLabels.includes(alias)) {
      fail(`<x:| element completion must offer the intrinsic ${alias} (got ${JSON.stringify(xelEmptyLabels)})`);
    }
  }

  const xelFilter = pageRes("<x:Dou|");
  const xelFilterLabels = await completeWith(422, xelFilter, "intrinsic-element-filter");
  if (!xelFilterLabels.includes("Double") || xelFilterLabels.includes("Int32") || xelFilterLabels.includes("String")) {
    fail(`<x:Dou| must filter intrinsic elements to Double only (got ${JSON.stringify(xelFilterLabels)})`);
  }

  // Unprefixed element position (default presentation ns) must NOT offer intrinsics — you write <x:String>.
  const xelDefault = `<Page ${NS}>\n  <|\n</Page>`;
  const xelDefaultLabels = await completeWith(423, xelDefault, "intrinsic-element-default-ns");
  if (xelDefaultLabels.includes("Int32") || xelDefaultLabels.includes("Double")) {
    fail(`unprefixed <| must not offer intrinsic elements (got ${JSON.stringify(xelDefaultLabels)})`);
  }

  // A custom prefix mapped to the XAML language URI offers intrinsic elements too (gate is by resolved URI).
  const xelCustom = `<Page ${NS} xmlns:sys="http://schemas.microsoft.com/winfx/2006/xaml">\n  <Page.Resources>\n    <sys:Str|\n  </Page.Resources>\n</Page>`;
  const xelCustomLabels = await completeWith(424, xelCustom, "intrinsic-element-custom-prefix");
  if (!xelCustomLabels.includes("String")) {
    fail(`<sys:Str| (custom prefix on the XAML URI) must offer the String intrinsic element (got ${JSON.stringify(xelCustomLabels)})`);
  }

  // Assignability: inside a typed collection property element the intrinsics are filtered out, exactly as
  // the CLR element list is — <Grid.RowDefinitions> offers RowDefinition, not <x:String>.
  const xelTyped = `<Page ${NS}>\n  <Grid>\n    <Grid.RowDefinitions>\n      <x:|\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`;
  const xelTypedLabels = await completeWith(425, xelTyped, "intrinsic-element-assignability");
  if (xelTypedLabels.includes("String") || xelTypedLabels.includes("Int32") || xelTypedLabels.includes("Double")) {
    fail(`<Grid.RowDefinitions><x:| must not offer non-assignable intrinsic elements (got ${JSON.stringify(xelTypedLabels)})`);
  }
  console.log(`[ok] XAML intrinsics as ELEMENTS: <x:| offers the full 14 (incl. value types) in resources; partial-filtered; unprefixed offers none; custom XAML-URI prefix works; typed collection property element filters them by assignability (round 58)`);

  // 437-440) contextual parent-container attached-property name completion (round 63) — a child element's attribute-name list also offers the nearest container's attached properties (e.g. Grid.Row/Column on a child of a <Grid>), ranked after the element's own members, exactly like VS/Blend. Immediate container only (self-limiting: a container with no attached properties adds nothing).
  const gridChild = `<Page ${NS}>\n  <Grid>\n    <Button |/>\n  </Grid>\n</Page>`;
  const gridChildLabels = await completeWith(437, gridChild, "container-attached-grid");
  for (const want of ["Grid.Row", "Grid.Column", "Grid.RowSpan", "Grid.ColumnSpan"]) {
    if (!gridChildLabels.includes(want)) {
      fail(`<Grid><Button | must offer the container's attached property '${want}' (got ${JSON.stringify(gridChildLabels.filter((l) => l.startsWith("Grid.")))})`);
    }
  }
  if (!gridChildLabels.includes("IsEnabled")) {
    fail(`<Grid><Button | must still offer the element's OWN members (IsEnabled) alongside attached props (got ${JSON.stringify(gridChildLabels.slice(0, 20))})`);
  }

  const gridChildPartial = `<Page ${NS}>\n  <Grid>\n    <Button Ro|/>\n  </Grid>\n</Page>`;
  const gridPartialLabels = await completeWith(438, gridChildPartial, "container-attached-grid-partial");
  if (!gridPartialLabels.includes("Grid.Row") || !gridPartialLabels.includes("Grid.RowSpan")) {
    fail(`partial 'Ro' must match the attached member name -> Grid.Row/Grid.RowSpan (got ${JSON.stringify(gridPartialLabels.filter((l) => l.startsWith("Grid.")))})`);
  }
  if (gridPartialLabels.includes("Grid.Column")) {
    fail(`partial 'Ro' must NOT surface Grid.Column (member 'Column' does not start with 'Ro'; got ${JSON.stringify(gridPartialLabels.filter((l) => l.startsWith("Grid.")))})`);
  }

  const canvasChild = `<Page ${NS}>\n  <Canvas>\n    <Button |/>\n  </Canvas>\n</Page>`;
  const canvasChildLabels = await completeWith(439, canvasChild, "container-attached-canvas");
  for (const want of ["Canvas.Left", "Canvas.Top"]) {
    if (!canvasChildLabels.includes(want)) {
      fail(`<Canvas><Button | must offer '${want}' (got ${JSON.stringify(canvasChildLabels.filter((l) => l.startsWith("Canvas.")))})`);
    }
  }
  if (canvasChildLabels.includes("Grid.Row")) {
    fail(`a Canvas child must NOT offer Grid.Row (only the immediate container's attached properties; got ${JSON.stringify(canvasChildLabels.filter((l) => l.includes(".")))})`);
  }

  // Immediate-container scoping + self-limiting: a StackPanel defines no attached properties, so a StackPanel
  // child (even nested inside a Grid) offers NO attached properties — Grid.Row applies to the StackPanel, not
  // to the StackPanel's own child.
  const stackChild = `<Page ${NS}>\n  <Grid>\n    <StackPanel>\n      <Button |/>\n    </StackPanel>\n  </Grid>\n</Page>`;
  const stackChildLabels = await completeWith(440, stackChild, "container-attached-none");
  if (stackChildLabels.includes("Grid.Row") || stackChildLabels.includes("Canvas.Left")) {
    fail(`a StackPanel child must offer NO container attached properties (StackPanel has none; Grid is not the immediate container; got ${JSON.stringify(stackChildLabels.filter((l) => l.includes(".")))})`);
  }
  if (!stackChildLabels.includes("IsEnabled")) {
    fail(`a StackPanel child must still offer its own members (IsEnabled) (got ${JSON.stringify(stackChildLabels.slice(0, 20))})`);
  }
  console.log(`[ok] container attached-property completion: a child offers the immediate container's attached props (Grid.Row/Column, Canvas.Left/Top) after its own members; member-partial filtered; self-limiting (round 63)`);

  // 441-445) mc:Ignorable value completion (round 64) — the near-universal WinUI header attribute lists the
  //      namespace prefixes a runtime XAML processor may ignore; offer the declared DESIGN-TIME prefixes
  //      (space-separated aware), matched by the RESOLVED markup-compatibility URI so a custom prefix works.
  const D2008 = "http://schemas.microsoft.com/expression/blend/2008";
  const D2006 = "http://schemas.microsoft.com/expression/blend/2006";
  const mcHeader = (rootAttrs) =>
    `<Page ${NS} xmlns:d="${D2008}" xmlns:dd="${D2006}" xmlns:mc="${MC}" ${rootAttrs}>\n  <Grid />\n</Page>`;

  const mcEmpty = await completeWith(441, mcHeader('mc:Ignorable="|"'), "mc-ignorable-empty");
  for (const want of ["d", "dd"]) {
    if (!mcEmpty.includes(want)) {
      fail(`mc:Ignorable="|" must offer the declared design-time prefix '${want}' (got ${JSON.stringify(mcEmpty)})`);
    }
  }
  for (const notWant of ["mc", "x"]) {
    if (mcEmpty.includes(notWant)) {
      fail(`mc:Ignorable must NOT offer the non-design-time prefix '${notWant}' (got ${JSON.stringify(mcEmpty)})`);
    }
  }

  const mcPartial = await completeWith(442, mcHeader('mc:Ignorable="d|"'), "mc-ignorable-partial");
  if (!mcPartial.includes("d") || !mcPartial.includes("dd")) {
    fail(`mc:Ignorable="d|" must match both 'd' and 'dd' (StartsWith 'd'; got ${JSON.stringify(mcPartial)})`);
  }
  const mcGarbage = await completeWith(443, mcHeader('mc:Ignorable="z|"'), "mc-ignorable-garbage");
  if (mcGarbage.length !== 0) {
    fail(`mc:Ignorable="z|" must offer nothing (no design-time prefix starts with 'z'; got ${JSON.stringify(mcGarbage)})`);
  }

  // Space-separated: 'd' already listed -> offer only the remaining design-time prefix 'dd', and the edit must
  // replace ONLY the current (empty) token after the space, not the whole "d " value.
  const mcSecond = await completeItemsWith(444, mcHeader('mc:Ignorable="d |"'), "mc-ignorable-second");
  const mcSecondLabels = mcSecond.map((i) => i.label);
  if (!mcSecondLabels.includes("dd") || mcSecondLabels.includes("d")) {
    fail(`mc:Ignorable="d |" must offer 'dd' and NOT re-offer the already-listed 'd' (got ${JSON.stringify(mcSecondLabels)})`);
  }
  const ddItem = mcSecond.find((i) => i.label === "dd");
  if (ddItem.textEdit.newText !== "dd") {
    fail(`the second-token edit must insert just 'dd' (got ${JSON.stringify(ddItem.textEdit)})`);
  }

  // Resolved-URI gating: a CUSTOM prefix mapped to the markup-compatibility URI is also mc:Ignorable; a
  // design-time-prefixed 'Ignorable' (wrong URI) is NOT.
  const mcCustom = await completeWith(445,
    `<Page ${NS} xmlns:d="${D2008}" xmlns:compat="${MC}" compat:Ignorable="|">\n  <Grid />\n</Page>`,
    "mc-ignorable-custom-prefix");
  if (!mcCustom.includes("d")) {
    fail(`compat:Ignorable (custom prefix on the markup-compat URI) must offer 'd' (got ${JSON.stringify(mcCustom)})`);
  }
  const mcWrongUri = await completeWith(446,
    `<Page ${NS} xmlns:d="${D2008}" d:Ignorable="|">\n  <Grid />\n</Page>`,
    "mc-ignorable-wrong-uri");
  if (mcWrongUri.includes("d")) {
    fail(`d:Ignorable (design-time prefix, NOT the markup-compat URI) must not be treated as mc:Ignorable (got ${JSON.stringify(mcWrongUri)})`);
  }
  console.log(`[ok] mc:Ignorable value completion: offers declared design-time prefixes (d/dd), space-separated aware (already-listed excluded, current-token edit), URI-gated (custom mc prefix works, design-time-prefixed Ignorable rejected) (round 64)`);

  // 447-450) x:Bind enum-argument VALUE completion (round 65) — {x:Bind} is compiled and has no reflectable extension type, so its enum-typed named arguments (Mode, UpdateSourceTrigger) resolve to null and previously the VALUE completed nothing even though the NAME is offered. A curated enum map now supplies the CLR enum so the value completes.
  const ust = await completeWith(447, pageCls('<TextBox Text="{x:Bind GreetingText, Mode=TwoWay, UpdateSourceTrigger=|}" />'), "xbind-ust");
  for (const want of ["Default", "PropertyChanged", "Explicit", "LostFocus"]) {
    if (!ust.includes(want)) fail(`x:Bind UpdateSourceTrigger completion missing '${want}' (got ${ust.join(",")})`);
  }
  const ustPartial = await completeWith(448, pageCls('<TextBox Text="{x:Bind GreetingText, UpdateSourceTrigger=Prop|}" />'), "xbind-ust-partial");
  if (!ustPartial.includes("PropertyChanged")) fail(`UpdateSourceTrigger='Prop' should offer PropertyChanged (got ${ustPartial.join(",")})`);
  if (ustPartial.includes("Default")) fail(`UpdateSourceTrigger='Prop' should not offer Default (got ${ustPartial.join(",")})`);
  // Regression: x:Bind Mode= still resolves BindingMode via the same map.
  const modeStill = await completeWith(449, pageCls('<TextBlock Text="{x:Bind GreetingText, Mode=|}" />'), "xbind-mode-still");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeStill.includes(want)) fail(`x:Bind Mode still must offer BindingMode '${want}' (got ${modeStill.join(",")})`);
  }
  // Classic {Binding} UpdateSourceTrigger resolves through its runtime extension type (unchanged path).
  const bindingUst = await completeWith(450, pageCls('<TextBox Text="{Binding Path=X, UpdateSourceTrigger=|}" />'), "binding-ust");
  for (const want of ["PropertyChanged", "LostFocus"]) {
    if (!bindingUst.includes(want)) fail(`classic Binding UpdateSourceTrigger missing '${want}' (got ${bindingUst.join(",")})`);
  }
  console.log(`[ok] x:Bind enum-argument value completion: UpdateSourceTrigger -> Default/PropertyChanged/Explicit/LostFocus (partial-filtered), Mode -> BindingMode preserved, classic Binding UpdateSourceTrigger via extension type (round 65)`);

  // 451) Leak guard (round 65): the curated x:Bind enum fallback is GATED to compiled-binding extensions, so
  //      a non-binding extension with a bogus same-named argument must NOT borrow BindingMode/UpdateSourceTrigger.
  const enumLeak = ["OneWay", "TwoWay", "OneTime", "Default", "PropertyChanged", "Explicit", "LostFocus"];
  for (const [id, ext] of [[451, "StaticResource"], [452, "TemplateBinding"]]) {
    for (const arg of ["Mode", "UpdateSourceTrigger"]) {
      const leaked = await completeWith(id, pageCls(`<TextBlock Text="{${ext} ${arg}=|}" />`), `${ext}-${arg}-leak`);
      const bad = leaked.filter((l) => enumLeak.includes(l));
      if (bad.length) fail(`{${ext} ${arg}=} must not leak binding enum values (got ${JSON.stringify(bad)})`);
    }
  }
  console.log(`[ok] x:Bind enum fallback is gated to bind extensions: StaticResource/TemplateBinding Mode=/UpdateSourceTrigger= leak no binding enums (round 65)`);

  // 453-456) XML-doc <summary> hover enrichment (round 66): symbol-based hovers now append the member's <summary> as quick-info (VS parity) for BOTH framework reference assemblies AND the user's own source. summaryOf() isolates the text AFTER the closing ``` fence, so each assertion proves the SUMMARY (not the signature) is present.
  const summaryOf = (v) => (v.split("```")[2] || "").trim();

  // 453) Framework element TYPE: Button's <summary> appears below the class signature.
  const docElem = await hoverAt(453, `<Page ${NS}>\n  <But|ton />\n</Page>`, "doc-element");
  if (!docElem.includes("class")) fail(`doc-element hover missing signature: ${docElem}`);
  if (!summaryOf(docElem).toLowerCase().includes("button")) fail(`doc-element hover missing framework <summary>: ${docElem}`);

  // 454) Framework PROPERTY: ContentControl.Content "Gets or sets ..." summary.
  const docAttr = await hoverAt(454, `<Page ${NS}>\n  <Button Con|tent="x" />\n</Page>`, "doc-attribute");
  if (!summaryOf(docAttr).toLowerCase().includes("gets or sets")) fail(`doc-attribute hover missing 'Gets or sets' <summary>: ${docAttr}`);

  // 455) USER SOURCE member: SmokePage.GreetingText carries the fixture's own <summary>, with the inline
  //      <see cref="IGreetingService"/> simplified to the bare type name.
  const docUser = await hoverAt(455, pageCls('<TextBlock Text="{x:Bind Greet|ingText}" />'), "doc-user-member");
  if (!docUser.includes("GreetingText")) fail(`doc-user hover missing signature: ${docUser}`);
  if (!summaryOf(docUser).includes("Greeting sourced from the DI singleton IGreetingService"))
    fail(`doc-user hover missing user <summary> with simplified see-cref: ${docUser}`);

  // 456) ATTACHED PROPERTY: the Grid.Row getter's <summary> ("Gets the value of the Grid.Row ...").
  const docAttached = await hoverAt(456, `<Page ${NS}>\n  <Grid>\n    <Button Grid.Ro|w="0" />\n  </Grid>\n</Page>`, "doc-attached");
  if (!docAttached.includes("(attached property)")) fail(`doc-attached hover missing signature: ${docAttached}`);
  if (!summaryOf(docAttached).toLowerCase().includes("gets the value")) fail(`doc-attached hover missing getter <summary>: ${docAttached}`);

  console.log(`[ok] hover doc-summary enrichment: framework type/property + user member (see-cref simplified) + attached-property getter carry <summary> quick-info (round 66)`);

  // 457-458) Authoring-markup sanitization (round 66 hardening): real framework summaries embed DocFX moniker
  //          zones, alert blockquotes, and escaped HTML (<img>/<sup>/<br>) as text. The hover must strip these
  //          to clean prose — never a broken <img> or a wall of ":::"/">"/"[!NOTE]" noise.
  const docExpander = await hoverAt(457, `<Page ${NS}>\n  <Expan|der />\n</Page>`, "doc-sanitize-moniker");
  {
    const s = summaryOf(docExpander);
    if (s.length === 0) fail(`Expander hover should carry a <summary>: ${docExpander}`);
    for (const bad of [":::", "moniker", "[!", "<img", "<sup", "<br", ">"]) {
      if (s.includes(bad)) fail(`Expander summary must be sanitized of '${bad}': ${JSON.stringify(s)}`);
    }
    if (!/displays a header/i.test(s)) fail(`Expander summary should surface the real prose: ${JSON.stringify(s)}`);
  }
  const docXyFocus = await hoverAt(458, `<Page ${NS}>\n  <Button XYFocusDownNavigationStrategy="Rectili|nearDistance" />\n</Page>`, "doc-sanitize-img");
  {
    const s = summaryOf(docXyFocus);
    if (s.length === 0) fail(`XYFocus enum-value hover should carry a <summary>: ${docXyFocus}`);
    for (const bad of ["<img", "src=", "<", ">"]) {
      if (s.includes(bad)) fail(`XYFocus RectilinearDistance summary must strip escaped HTML '${bad}': ${JSON.stringify(s)}`);
    }
    if (!/rectilinear|closest element/i.test(s)) fail(`XYFocus summary should surface the real prose: ${JSON.stringify(s)}`);
  }
  console.log(`[ok] hover doc-summary sanitization: Expander strips DocFX ::: moniker/[!CAUTION]; XYFocus.RectilinearDistance strips escaped <img> -> clean prose (round 66)`);

  // 459-463) Completion-item documentation (round 67): completion items now carry the member's XML-doc <summary> as their Documentation flyout (VS parity — the details pane beside the popup), reusing the round-66 XmlDocSummary engine. Unlike hover, CompletionDoc emits the summary PROSE ONLY (no signature fence), since VS renders Detail as the header and Documentation as the body. docOf() reads the MarkupContent value for a given label.
  const docOf = (items, lbl) => items.find((i) => i.label === lbl)?.documentation?.value ?? "";

  // 459) Framework element TYPE: <Button completion carries Button's <summary>.
  const cdElem = await completeItemsWith(459, `<Page ${NS}>\n  <But|\n</Page>`, "compdoc-element");
  {
    const d = docOf(cdElem, "Button");
    if (d.length === 0) fail(`Button completion item should carry documentation: ${JSON.stringify(cdElem.find((i) => i.label === "Button"))}`);
    if (!d.toLowerCase().includes("button")) fail(`Button completion documentation missing framework <summary>: ${JSON.stringify(d)}`);
  }

  // 460) Framework PROPERTY: the Content attribute-name item carries "Gets or sets ..." — proving the
  //      XamlMemberInfo.Symbol path documents attribute completion, not just element completion.
  const cdAttr = await completeItemsWith(460, `<Page ${NS}>\n  <Button |\n</Page>`, "compdoc-attribute");
  if (!docOf(cdAttr, "Content").toLowerCase().includes("gets or sets"))
    fail(`Content completion documentation missing 'Gets or sets' <summary>: ${JSON.stringify(docOf(cdAttr, "Content"))}`);

  // 461) Framework ENUM value: Visibility.Collapsed completion carries the field's <summary> (high value —
  //      framework enum members are well-documented) and the round-66 sanitizer runs on completion docs too.
  const cdEnum = await completeItemsWith(461, `<Page ${NS}>\n  <Button Visibility="|" />\n</Page>`, "compdoc-enum");
  {
    const d = docOf(cdEnum, "Collapsed");
    if (d.length === 0) fail(`Visibility.Collapsed completion item should carry documentation: ${JSON.stringify(cdEnum.find((i) => i.label === "Collapsed"))}`);
    if (!d.toLowerCase().includes("display")) fail(`Collapsed completion documentation missing enum <summary>: ${JSON.stringify(d)}`);
    for (const bad of [":::", "<img", "[!"]) if (d.includes(bad)) fail(`Collapsed completion documentation must be sanitized of '${bad}': ${JSON.stringify(d)}`);
  }

  // 462) USER SOURCE member: {x:Bind Gree|} completes GreetingText with the fixture's OWN <summary>, with the
  //      inline <see cref="IGreetingService"/> simplified — proving source symbols document completion.
  const cdUser = await completeItemsWith(462, pageCls('<TextBlock Text="{x:Bind Gree|}" />'), "compdoc-user");
  if (!docOf(cdUser, "GreetingText").includes("Greeting sourced from the DI singleton IGreetingService"))
    fail(`GreetingText completion documentation missing user <summary> with simplified see-cref: ${JSON.stringify(docOf(cdUser, "GreetingText"))}`);

  // 463) ATTACHED PROPERTY: <Button Grid.| completes Grid.Row with the getter's <summary> ("Gets the value ...").
  const cdAttached = await completeItemsWith(463, `<Page ${NS}>\n  <Grid>\n    <Button Grid.|\n  </Grid>\n</Page>`, "compdoc-attached");
  if (!docOf(cdAttached, "Grid.Row").toLowerCase().includes("gets the value"))
    fail(`Grid.Row completion documentation missing attached getter <summary>: ${JSON.stringify(docOf(cdAttached, "Grid.Row"))}`);

  console.log(`[ok] completion documentation: framework element/property/enum + user member (see-cref simplified) + attached-property completion items carry <summary> quick-info, sanitized (round 67)`);

  // 464-466) x:Bind markup-extension argument-NAME documentation (round 68): the curated {x:Bind} arg-name list (Mode/Converter/.../UpdateSourceTrigger + BindBack) previously carried NO documentation, while the classic {Binding} arg names ARE documented (round 67, via reflected symbols). Round 68 resolves each curated name to its Microsoft.UI.Xaml.Data.Binding property symbol and reuses CompletionDoc, so x:Bind arg names read IDENTICALLY to classic Binding; BindBack (x:Bind-only, no Binding property) gets a small curated doc.

  // 464) x:Bind arg names now carry docs: Mode/Converter borrow Binding's "Gets or sets ..." <summary>;
  //      BindBack carries the curated x:Bind-only doc.
  const xbArg = await completeItemsWith(464, pageCls('<TextBlock Text="{x:Bind GreetingText, |}" />'), "xbind-argname-doc");
  {
    const dMode = docOf(xbArg, "Mode");
    if (!dMode.toLowerCase().includes("gets or sets")) fail(`x:Bind Mode arg-name should carry Binding.Mode <summary>: ${JSON.stringify(dMode)}`);
    const dConv = docOf(xbArg, "Converter");
    if (!dConv.toLowerCase().includes("gets or sets")) fail(`x:Bind Converter arg-name should carry Binding.Converter <summary>: ${JSON.stringify(dConv)}`);
    const dBB = docOf(xbArg, "BindBack");
    if (dBB.length === 0 || !dBB.toLowerCase().includes("back")) fail(`x:Bind BindBack arg-name should carry the curated TwoWay-write-back doc: ${JSON.stringify(dBB)}`);
    for (const bad of [":::", "<img", "[!", "```"]) if (dMode.includes(bad)) fail(`x:Bind Mode doc must be sanitized of '${bad}': ${JSON.stringify(dMode)}`);
  }

  // 465) CONSISTENCY (the headline): the x:Bind Mode doc is BYTE-IDENTICAL to the classic Binding Mode doc,
  //      since both resolve the SAME Binding.Mode symbol. Classic arg-name completion fires after a comma.
  const bnArg = await completeItemsWith(465, pageCls('<TextBlock Text="{Binding Path=GreetingText, |}" />'), "binding-argname-doc");
  {
    const dX = docOf(xbArg, "Mode");
    const dB = docOf(bnArg, "Mode");
    if (dB.length === 0) fail(`classic Binding Mode arg-name should carry documentation (round 67): ${JSON.stringify(bnArg.map((i) => i.label))}`);
    if (dX !== dB) fail(`x:Bind Mode doc must equal classic Binding Mode doc (consistency):\n  x:Bind=${JSON.stringify(dX)}\n  Binding=${JSON.stringify(dB)}`);
  }

  // 466) BindBack is x:Bind-ONLY: it appears in the x:Bind curated list (with a doc) but classic {Binding}
  //      has no BindBack property, so it is NOT offered there at all — proving the curated fallback is scoped.
  {
    if (!xbArg.some((i) => i.label === "BindBack")) fail(`x:Bind arg names must include BindBack`);
    if (bnArg.some((i) => i.label === "BindBack")) fail(`classic Binding must NOT offer BindBack (x:Bind-only): ${JSON.stringify(bnArg.map((i) => i.label))}`);
  }

  console.log(`[ok] x:Bind arg-name documentation: curated {x:Bind} arg names carry Binding.<Property> <summary> (Mode/Converter), BindBack curated doc, x:Bind Mode doc === classic Binding Mode doc (consistency), BindBack x:Bind-only (round 68)`);

  // 467-468) x:Bind argument-name Detail-line parity (round 69): the curated {x:Bind} arg names now ALSO carry the same Detail (the dimmed "property : Type" type-hint header) that the classic {Binding} arg name shows — off the SAME resolved Binding member — so BOTH the popup header (Detail) and body (Documentation) reach parity. BindBack (x:Bind-only) gets a small curated "method" detail.
  const detailOf = (items, lbl) => items.find((i) => i.label === lbl)?.detail ?? "";

  // 467) Mode/Converter Detail is non-empty AND byte-identical to the classic Binding arg Detail (parity),
  //      while the round-68 documentation stays intact (no regression).
  {
    const dxMode = detailOf(xbArg, "Mode");
    const dbMode = detailOf(bnArg, "Mode");
    if (dbMode.length === 0) fail(`classic Binding Mode arg should carry a Detail: ${JSON.stringify(bnArg.find((i) => i.label === "Mode"))}`);
    if (dxMode !== dbMode) fail(`x:Bind Mode Detail must equal classic Binding Mode Detail:\n  x:Bind=${JSON.stringify(dxMode)}\n  Binding=${JSON.stringify(dbMode)}`);
    if (!/property\s*:/i.test(dxMode)) fail(`x:Bind Mode Detail should read 'property : <Type>': ${JSON.stringify(dxMode)}`);
    const dxConv = detailOf(xbArg, "Converter");
    if (dxConv !== detailOf(bnArg, "Converter")) fail(`x:Bind Converter Detail must equal classic Binding Converter Detail: x=${JSON.stringify(dxConv)} b=${JSON.stringify(detailOf(bnArg, "Converter"))}`);
    if (docOf(xbArg, "Mode").length === 0) fail(`round-68 documentation must remain after adding Detail (Mode)`);
  }

  // 468) BindBack carries the curated x:Bind-only Detail (no Binding property to borrow) and still its doc.
  {
    const dBB = detailOf(xbArg, "BindBack");
    if (dBB !== "method") fail(`x:Bind BindBack Detail should be the curated 'method': ${JSON.stringify(dBB)}`);
    if (docOf(xbArg, "BindBack").length === 0) fail(`BindBack documentation must remain after adding Detail`);
  }

  console.log(`[ok] x:Bind arg-name Detail parity: curated {x:Bind} arg Detail === classic Binding arg Detail ('property : Type', Mode/Converter), BindBack curated 'method' detail, round-68 docs intact (round 69)`);

  // 469-472) Method hover <returns>/<param> enrichment (round 70): a hover on a METHOD symbol now appends the member's <returns> and documented <param>s below the summary (VS quick-info parity), reusing the round-66 XmlDocSummary engine (new ExtractQuickInfo). Gated to IMethodSymbol so properties/fields/ types/enums stay summary-only, and attached-property getters (presented AS a property) pass methodDetails:false so they are NOT enriched. Proven end-to-end on the REAL SDK.

  // 469) Framework page-inherited method {x:Bind FindName}: signature + summary + Returns + Parameters `name`.
  const mFindName = await hoverAt(469, pageCls('<TextBlock Text="{x:Bind Find|Name}" />'), "method-hover-findname");
  {
    if (!mFindName.includes("object FrameworkElement.FindName(string name)")) fail(`FindName hover missing signature: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("**Returns:**")) fail(`FindName hover should carry a Returns section: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("**Parameters:**")) fail(`FindName hover should carry a Parameters section: ${JSON.stringify(mFindName)}`);
    if (!mFindName.includes("`name`")) fail(`FindName hover should document the 'name' param: ${JSON.stringify(mFindName)}`);
  }

  // 470) Framework MEMBER method via a string segment {x:Bind GreetingText.Substring}: enriched too.
  const mSubstring = await hoverAt(470, pageCls('<TextBlock Text="{x:Bind GreetingText.Subs|tring}" />'), "method-hover-substring");
  {
    if (!mSubstring.includes("string string.Substring(int startIndex)")) fail(`Substring hover missing signature: ${JSON.stringify(mSubstring)}`);
    if (!mSubstring.includes("**Returns:**")) fail(`Substring hover should carry a Returns section: ${JSON.stringify(mSubstring)}`);
    if (!mSubstring.includes("`startIndex`")) fail(`Substring hover should document the 'startIndex' param: ${JSON.stringify(mSubstring)}`);
  }

  // 471) NEGATIVE — an undocumented USER method (function binding) stays signature-only, byte-identical to the
  //      pre-round-70 behavior (no phantom empty Returns/Parameters sections).
  const mUserFn = await hoverAt(471, pageCls('<TextBlock Text="{x:Bind OnGo_C|lick()}" />'), "method-hover-user-nodoc");
  {
    const expected = "```csharp\nvoid SmokePage.OnGo_Click(object sender, RoutedEventArgs e)\n```";
    if (mUserFn !== expected) fail(`Undocumented user method hover must be signature-only: ${JSON.stringify(mUserFn)}`);
  }

  // 472) NEGATIVE — an attached-property hover is presented AS a property (methodDetails:false), so even though
  //      its resolved symbol is the getter METHOD, it is NOT enriched with the getter's Returns/Parameters.
  const mAttached = await hoverAt(472, pageCls('<Grid>\n    <Button Grid.R|ow="1" />\n  </Grid>'), "method-hover-attached-noenrich");
  {
    if (!mAttached.includes("(attached property)")) fail(`Grid.Row hover should identify the attached property: ${JSON.stringify(mAttached)}`);
    if (mAttached.includes("**Returns:**") || mAttached.includes("**Parameters:**")) fail(`attached-property hover must NOT carry method Returns/Parameters: ${JSON.stringify(mAttached)}`);
  }

  console.log(`[ok] method hover enrichment: {x:Bind FindName}/GreetingText.Substring show Returns + Parameters; undocumented OnGo_Click stays signature-only; attached Grid.Row not enriched (round 70)`);

  // 473-476) GridLength value completion (round 71): a GridLength-typed attribute value (RowDefinition.Height,
  //          ColumnDefinition.Width) now offers the two keyword sizings VS/Blend surface — Auto and * — while
  //          a 'double' Width/Height (FrameworkElement) correctly offers neither. Curated + benign-empty.
  const gridLenOf = (items) => items.filter((i) => (i.detail ?? "").startsWith("GridLength")).map((i) => i.label).sort();

  // 473) RowDefinition.Height empty -> exactly [*, Auto] with the GridLength detail + whole-token newText.
  const glRow = await completeItemsWith(473, pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="|" />\n    </Grid.RowDefinitions>\n  </Grid>'), "gridlength-row");
  {
    const labels = gridLenOf(glRow);
    if (labels.join(",") !== "*,Auto") fail(`RowDefinition.Height should offer Auto and *: ${JSON.stringify(glRow.map((i) => i.label))}`);
    const auto = glRow.find((i) => i.label === "Auto");
    if (auto?.textEdit?.newText !== "Auto") fail(`Auto item should carry a whole-token TextEdit: ${JSON.stringify(auto)}`);
    // RAW-WIRE lock: the server sets FilterText = SortText = the token so client-side filtering matches the label.
    // (VS Code's executeCompletionItemProvider omits these when they equal the label, so the harness cannot see
    // them — this stdio smoke is the authoritative layer for the wire contract; see redteam71 assertExactGridShapes.)
    if (auto?.filterText !== "Auto" || auto?.sortText !== "Auto") fail(`Auto item should carry filterText/sortText = token on the wire: ${JSON.stringify(auto)}`);
    const star = glRow.find((i) => i.label === "*");
    if (star?.filterText !== "*" || star?.sortText !== "*") fail(`* item should carry filterText/sortText = token on the wire: ${JSON.stringify(star)}`);
    if (glRow.some((i) => i.label === "True" || i.label === "False")) fail(`GridLength value must not offer booleans: ${JSON.stringify(glRow.map((i) => i.label))}`);
  }

  // 474) RowDefinition.Height partial 'A' -> Auto only (prefix filter), no *.
  const glPartial = await completeItemsWith(474, pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="A|" />\n    </Grid.RowDefinitions>\n  </Grid>'), "gridlength-partial");
  {
    const labels = gridLenOf(glPartial);
    if (labels.join(",") !== "Auto") fail(`partial 'A' should offer only Auto: ${JSON.stringify(glPartial.map((i) => i.label))}`);
  }

  // 475) ColumnDefinition.Width empty -> Auto and * too (GridLength on the column axis).
  const glCol = await completeItemsWith(475, pageCls('<Grid>\n    <Grid.ColumnDefinitions>\n      <ColumnDefinition Width="|" />\n    </Grid.ColumnDefinitions>\n  </Grid>'), "gridlength-col");
  {
    if (gridLenOf(glCol).join(",") !== "*,Auto") fail(`ColumnDefinition.Width should offer Auto and *: ${JSON.stringify(glCol.map((i) => i.label))}`);
  }

  // 476) NEGATIVE — FrameworkElement.Width is 'double', NOT GridLength, so no Auto/* is offered.
  const glDouble = await completeItemsWith(476, pageCls('<Button Width="|" />'), "gridlength-double-negative");
  {
    if (gridLenOf(glDouble).length !== 0) fail(`a double Width must NOT offer GridLength keywords: ${JSON.stringify(glDouble.map((i) => i.label))}`);
  }

  console.log(`[ok] GridLength value completion: RowDefinition.Height / ColumnDefinition.Width offer Auto + * (prefix-filtered); double FrameworkElement.Width offers neither (round 71)`);

  // 477-481) Named-color value completion (round 72): a Brush/Color-typed attribute value now completes the
  //          WinUI named colors (Microsoft.UI.Colors — Red, CornflowerBlue, …, Transparent) with a Color-kind
  //          item + hex Detail (swatch), while a non-Brush/Color value (double/enum/string) offers none.
  const colorItems = (items) => items.filter((i) => i.kind === 16); // CompletionItemKind.Color
  const colorLabels = (items) => colorItems(items).map((i) => i.label);

  // 477) Foreground (Brush) empty -> the full named-color set incl. CornflowerBlue/Red/Transparent, Color-kind,
  //      whole-token TextEdit, hex Detail (swatch) + raw-wire filterText/sortText = token.
  const clrFg = await completeItemsWith(477, pageCls('<TextBlock Foreground="|" />'), "namedcolor-foreground");
  {
    const labels = colorLabels(clrFg);
    if (labels.length < 100) fail(`Foreground should offer the full named-color set (got ${labels.length})`);
    for (const want of ["Red", "CornflowerBlue", "Transparent", "AliceBlue", "YellowGreen"]) {
      if (!labels.includes(want)) fail(`Foreground named colors missing ${want}: ${labels.length} items`);
    }
    const cfb = clrFg.find((i) => i.label === "CornflowerBlue");
    if (cfb?.textEdit?.newText !== "CornflowerBlue") fail(`CornflowerBlue should carry a whole-token TextEdit: ${JSON.stringify(cfb)}`);
    if (cfb?.detail !== "#6495ED") fail(`CornflowerBlue detail should be its hex swatch #6495ED: ${JSON.stringify(cfb?.detail)}`);
    if (cfb?.filterText !== "CornflowerBlue" || cfb?.sortText !== "CornflowerBlue") fail(`CornflowerBlue should carry filterText/sortText = token on the wire: ${JSON.stringify(cfb)}`);
    const tr = clrFg.find((i) => i.label === "Transparent");
    if (tr?.detail !== "#FFFFFF00") fail(`Transparent detail should be CSS alpha-last #FFFFFF00: ${JSON.stringify(tr?.detail)}`);
    if (clrFg.some((i) => i.label === "True" || i.label === "False")) fail(`a Brush value must not offer booleans`);
  }

  // 478) Foreground partial 'Corn' -> only Cornflower* / Cornsilk (prefix filter, OrdinalIgnoreCase).
  const clrPartial = await completeItemsWith(478, pageCls('<TextBlock Foreground="Corn|" />'), "namedcolor-partial");
  {
    const labels = colorLabels(clrPartial).sort();
    if (labels.join(",") !== "CornflowerBlue,Cornsilk") fail(`partial 'Corn' should offer CornflowerBlue + Cornsilk only: ${JSON.stringify(labels)}`);
  }

  // 479) Background (also a Brush) -> named colors too.
  const clrBg = await completeItemsWith(479, pageCls('<Grid Background="|" />'), "namedcolor-background");
  {
    if (!colorLabels(clrBg).includes("Red")) fail(`Background (Brush) should offer named colors incl. Red`);
  }

  // 480) SolidColorBrush.Color (a Windows.UI.Color value, not a Brush) -> named colors via IsColor.
  const clrColorProp = await completeItemsWith(480, pageCls('<Grid>\n    <Grid.Background>\n      <SolidColorBrush Color="|" />\n    </Grid.Background>\n  </Grid>'), "namedcolor-color-prop");
  {
    if (!colorLabels(clrColorProp).includes("CornflowerBlue")) fail(`SolidColorBrush.Color (Windows.UI.Color) should offer named colors incl. CornflowerBlue`);
  }

  // 481) NEGATIVE — a double (Width) and an enum (Visibility) must NOT offer named colors.
  const clrDouble = await completeItemsWith(481, pageCls('<Button Width="|" />'), "namedcolor-double-negative");
  {
    if (colorItems(clrDouble).length !== 0) fail(`a double Width must NOT offer named colors: ${JSON.stringify(colorLabels(clrDouble))}`);
    const clrEnum = await completeWith(482, pageCls('<Button Visibility="|" />'), "namedcolor-enum-negative");
    if (clrEnum.includes("Red") || clrEnum.includes("CornflowerBlue")) fail(`an enum Visibility must NOT leak named colors: ${JSON.stringify(clrEnum)}`);
  }

  console.log(`[ok] Named-color value completion: Brush (Foreground/Background) + Color (SolidColorBrush.Color) offer the WinUI named colors with hex swatches (prefix-filtered); double/enum offer none (round 72)`);

  // 483-484) Mid-token accept replaces the WHOLE value token (round 72 fix): with the caret inside an existing
  //          value ("Corn|silk"), the item's TextEdit range must span the whole token so applying it yields a
  //          clean value, never a duplicated suffix ("Cornsilksilk"). The same fix covers the GridLength sibling.
  const applyEdit = (text, range, newText) => {
    const toOffset = (pos) => {
      const lines = text.split("\n");
      let off = 0;
      for (let l = 0; l < pos.line; l++) off += lines[l].length + 1;
      return off + pos.character;
    };
    return text.slice(0, toOffset(range.start)) + newText + text.slice(toOffset(range.end));
  };

  // 483) Foreground="Corn|silk" accepting Cornsilk -> Foreground="Cornsilk" (no dangling 'silk').
  {
    const body = pageCls('<TextBlock Foreground="Corn|silk" Tag="tail" />');
    const items = await completeItemsWith(483, body, "namedcolor-midtoken");
    const text = body.replaceAll("|", "");
    const cs = items.find((i) => i.label === "Cornsilk" && i.kind === 16);
    if (!cs?.textEdit) fail(`mid-token Cornsilk should carry a TextEdit: ${JSON.stringify(cs)}`);
    const applied = applyEdit(text, cs.textEdit.range, cs.textEdit.newText);
    if (!applied.includes('Foreground="Cornsilk" Tag="tail"')) fail(`mid-token accept must replace the whole token: ${JSON.stringify(applied.match(/Foreground="[^"]*"/)?.[0])}`);
    if (applied.includes("Cornsilksilk")) fail(`mid-token accept duplicated the suffix (Cornsilksilk)`);
  }

  // 484) GridLength Height="A|uto" accepting Auto -> Height="Auto" (sibling scalar fix, same whole-token range).
  {
    const body = pageCls('<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition Height="A|uto" />\n    </Grid.RowDefinitions>\n  </Grid>');
    const items = await completeItemsWith(484, body, "gridlength-midtoken");
    const text = body.replaceAll("|", "");
    const au = items.find((i) => i.label === "Auto" && (i.detail ?? "").startsWith("GridLength"));
    if (!au?.textEdit) fail(`mid-token Auto should carry a TextEdit: ${JSON.stringify(au)}`);
    const applied = applyEdit(text, au.textEdit.range, au.textEdit.newText);
    if (!applied.includes('Height="Auto"')) fail(`mid-token GridLength accept must replace the whole token: ${JSON.stringify(applied.match(/Height="[^"]*"/)?.[0])}`);
    if (applied.includes("Autouto")) fail(`mid-token GridLength accept duplicated the suffix (Autouto)`);
  }

  console.log(`[ok] Mid-token value accept replaces the whole token (no duplicated suffix) for named colors + GridLength (round 72 fix)`);

  // 485-489) FontWeight named-value completion (round 73): a FontWeight-typed attribute value (Control/TextBlock.FontWeight, typed Windows.UI.Text.FontWeight) now completes the named weights (Microsoft.UI.Text.FontWeights — Thin, Light, Normal, SemiBold, Bold, …, ExtraBlack) as Value-kind items whose Detail is the numeric weight (Bold => 700). Numeric literals stay free-form.
  const fwItems = (items) => items.filter((i) => /^\d{2,3}$/.test(i.detail ?? "")); // weight-number Detail (100..950)
  const fwLabels = (items) => fwItems(items).map((i) => i.label);

  // 485) FontWeight empty -> the full 11-name set with weight-number Detail, Value-kind, whole-token TextEdit.
  const fw = await completeItemsWith(485, pageCls('<TextBlock FontWeight="|" />'), "fontweight-empty");
  {
    const labels = fwLabels(fw).sort();
    const want = ["Black", "Bold", "ExtraBlack", "ExtraBold", "ExtraLight", "Light", "Medium", "Normal", "SemiBold", "SemiLight", "Thin"];
    if (labels.join(",") !== want.join(",")) fail(`FontWeight empty should offer exactly the 11 named weights: ${JSON.stringify(labels)}`);
    const bold = fw.find((i) => i.label === "Bold");
    if (bold?.kind !== 12) fail(`Bold should be a Value-kind item: ${JSON.stringify(bold)}`);
    if (bold?.detail !== "700") fail(`Bold detail should be its weight number 700: ${JSON.stringify(bold?.detail)}`);
    if (bold?.textEdit?.newText !== "Bold") fail(`Bold should carry a whole-token TextEdit: ${JSON.stringify(bold)}`);
    const sl = fw.find((i) => i.label === "SemiLight");
    if (sl?.detail !== "350") fail(`SemiLight detail should be 350: ${JSON.stringify(sl?.detail)}`);
    const eb = fw.find((i) => i.label === "ExtraBlack");
    if (eb?.detail !== "950") fail(`ExtraBlack detail should be 950: ${JSON.stringify(eb?.detail)}`);
    if (fw.some((i) => i.label === "True" || i.label === "False")) fail(`a FontWeight value must not offer booleans`);
  }

  // 486) FontWeight partial 'Ex' -> only ExtraLight / ExtraBold / ExtraBlack (prefix filter, OrdinalIgnoreCase).
  const fwPartial = await completeItemsWith(486, pageCls('<TextBlock FontWeight="Ex|" />'), "fontweight-partial");
  {
    const labels = fwLabels(fwPartial).sort();
    if (labels.join(",") !== "ExtraBlack,ExtraBold,ExtraLight") fail(`partial 'Ex' should offer the three Extra* weights only: ${JSON.stringify(labels)}`);
  }

  // 487) FontWeight on a Control base type (Button) also completes (FontWeight is a Control property).
  const fwBtn = await completeItemsWith(487, pageCls('<Button FontWeight="|" />'), "fontweight-control");
  {
    if (!fwLabels(fwBtn).includes("SemiBold")) fail(`Button.FontWeight should offer named weights incl. SemiBold`);
  }

  // 488) NEGATIVE — a double (Width) and an enum (Visibility) must NOT offer named weights.
  {
    const fwDouble = await completeItemsWith(488, pageCls('<Button Width="|" />'), "fontweight-double-negative");
    if (fwItems(fwDouble).length !== 0) fail(`a double Width must NOT offer named weights: ${JSON.stringify(fwLabels(fwDouble))}`);
    const fwEnum = await completeWith(489, pageCls('<Button Visibility="|" />'), "fontweight-enum-negative");
    if (fwEnum.includes("Bold") || fwEnum.includes("SemiBold")) fail(`an enum Visibility must NOT leak named weights: ${JSON.stringify(fwEnum)}`);
  }

  console.log(`[ok] FontWeight value completion: Control/TextBlock.FontWeight offers the WinUI named weights with weight-number details (prefix-filtered); double/enum offer none (round 73)`);

  // 490-492) Setter.Value scalar completion generalized (round 73 fix): the <Setter Value="|"> path now shares the SAME scalar dispatch as ordinary attribute values, so a Style setter completes a FontWeight/Brush property identically to setting it directly (VS parity) — previously only enum/bool completed there. Typed by the sibling Property= against the enclosing TargetType. 490) <Setter Property="FontWeight" Value="|"> -> named weights (the round-73 deliverable in a Style).
  const svFw = await completeItemsWith(490, pageRes('<Style TargetType="Button">\n      <Setter Property="FontWeight" Value="|" />\n    </Style>'), "setterval-fontweight");
  {
    const labels = fwLabels(svFw).sort();
    if (!labels.includes("Bold") || !labels.includes("SemiBold")) fail(`Setter.Value FontWeight should offer named weights incl. Bold/SemiBold: ${JSON.stringify(labels)}`);
    const bold = svFw.find((i) => i.label === "Bold" && /^\d{2,3}$/.test(i.detail ?? ""));
    if (bold?.detail !== "700") fail(`Setter.Value Bold detail should be 700: ${JSON.stringify(bold?.detail)}`);
  }

  // 491) <Setter Property="Foreground" Value="|"> -> named colors (proves the shared dispatch generalized
  //      round-72 to Setter.Value too, not just FontWeight).
  const svClr = await completeItemsWith(491, pageRes('<Style TargetType="Button">\n      <Setter Property="Foreground" Value="|" />\n    </Style>'), "setterval-foreground");
  {
    if (!colorLabels(svClr).includes("CornflowerBlue")) fail(`Setter.Value Foreground (Brush) should offer named colors incl. CornflowerBlue: ${JSON.stringify(colorLabels(svClr))}`);
  }

  // 492) NEGATIVE — a double-typed setter value (Opacity) must offer neither weights nor colors.
  const svDbl = await completeItemsWith(492, pageRes('<Style TargetType="Button">\n      <Setter Property="Opacity" Value="|" />\n    </Style>'), "setterval-double-negative");
  {
    if (fwItems(svDbl).length !== 0 || colorItems(svDbl).length !== 0) fail(`a double Setter.Value (Opacity) must offer no weights/colors: ${JSON.stringify(svDbl.map((i) => i.label))}`);
  }

  console.log(`[ok] Setter.Value scalar completion generalized: <Setter Property="FontWeight"/Foreground" Value="|"> offers named weights/colors like a direct attribute (double offers none) (round 73 fix)`);

  // 493-494) USER GAP #1 (context-aware element types): element completion is narrowed to the nearest enclosing element's content type, so a panel child only offers UIElement-assignable types — NOT VisualStateManager / EventArgs / intrinsics (the noise the user reported). An object-typed content position (ContentControl.Content = object) stays permissive (VS parity). 493) A <Grid> child offers Button (a UIElement) but NOT VisualStateManager (a DependencyObject, not a UIElement) and NOT RoutedEventArgs (derives from object) — the headline fix for gap #1.
  {
    const gridChild = await completeWith(493, pageCls('<Grid>\n    <|\n  </Grid>'), "ctx-types-grid-child");
    if (!gridChild.includes("Button")) fail(`a <Grid> child should still offer Button (UIElement): ${JSON.stringify(gridChild.slice(0, 30))}`);
    if (gridChild.includes("VisualStateManager")) fail(`a <Grid> child must NOT offer VisualStateManager (not a UIElement): ${JSON.stringify(gridChild.filter((l) => /Manager|EventArgs/.test(l)))}`);
    if (gridChild.includes("RoutedEventArgs")) fail(`a <Grid> child must NOT offer RoutedEventArgs: ${JSON.stringify(gridChild.filter((l) => /EventArgs/.test(l)))}`);
  }
  // 494) An object-typed content position (a ContentControl's Content) stays permissive — VisualStateManager
  //      is still offered, proving the narrowing does not over-fire.
  {
    const objChild = await completeWith(494, pageCls('<Button>\n    <|\n  </Button>'), "ctx-types-object-content");
    if (!objChild.includes("Button")) fail(`object-content child should offer Button: ${JSON.stringify(objChild.slice(0, 20))}`);
    if (!objChild.includes("VisualStateManager")) fail(`object-content (Button.Content = object) child should stay permissive and offer VisualStateManager: ${JSON.stringify(objChild.slice(0, 30))}`);
  }
  console.log(`[ok] context-aware element types (#1): a <Grid> child narrows to UIElement (Button yes; VisualStateManager/RoutedEventArgs no) while object-typed content stays permissive (round 84)`);

  // 495-497) USER GAP #2 (attribute-name value quoting): an attribute/event-handler name completion now inserts `Name="$0"` as a snippet (caret between the quotes) via InsertTextFormat=2 + a whole-token TextEdit — instead of the bare unquoted name. Skipped when the name is already followed by `=` (the value already exists). Asserted on the RAW LSP wire (textEdit + format).
  const attrItem = (items, label) => items.find((i) => i.label === label);
  // 495) an EVENT handler name (Click) inserts Click="$0".
  {
    const items = await completeItemsWith(495, pageCls('<Button Cli|>'), "attr-snippet-event");
    const it = attrItem(items, "Click");
    if (!it) fail(`<Button Cli| should offer the Click event: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    if (it.textEdit?.newText !== 'Click="$0"') fail(`Click completion should insert the snippet Click="$0": ${JSON.stringify(it.textEdit)}`);
    if (it.insertTextFormat !== 2) fail(`Click completion should be a snippet (InsertTextFormat=2): ${JSON.stringify(it.insertTextFormat)}`);
    if (it.label !== "Click" || it.filterText === 'Click="$0"') fail(`the Click label/filterText must stay the bare name: ${JSON.stringify({ label: it.label, filterText: it.filterText })}`);
  }
  // 496) a PROPERTY name (Content) inserts Content="$0" too.
  {
    const items = await completeItemsWith(496, pageCls('<Button Con|>'), "attr-snippet-prop");
    const it = attrItem(items, "Content");
    if (!it) fail(`<Button Con| should offer the Content property: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    if (it.textEdit?.newText !== 'Content="$0"') fail(`Content completion should insert Content="$0": ${JSON.stringify(it.textEdit)}`);
    if (it.insertTextFormat !== 2) fail(`Content completion should be a snippet (InsertTextFormat=2): ${JSON.stringify(it.insertTextFormat)}`);
  }
  // 497) NEGATIVE — when the name is ALREADY followed by `=`, the item stays BARE (no snippet, value exists).
  {
    const items = await completeItemsWith(497, pageCls('<Button Click|="OnGo_Click" />'), "attr-snippet-already-has-value");
    const it = attrItem(items, "Click");
    if (!it) fail(`<Button Click|="..." should still offer the Click event: ${JSON.stringify(items.map((i) => i.label).slice(0, 20))}`);
    const nt = it.textEdit?.newText ?? it.insertText;
    if (nt && nt.includes('="$0"')) fail(`Click already followed by '=' must NOT re-append a value snippet: ${JSON.stringify({ newText: it.textEdit?.newText, insertText: it.insertText })}`);
    if (it.insertTextFormat === 2) fail(`Click already followed by '=' must NOT be a snippet: ${JSON.stringify(it.insertTextFormat)}`);
  }
  console.log(`[ok] attribute value-snippet (#2): event/property name completion inserts Name="$0" (InsertTextFormat=2, bare label) and stays bare when a value already follows '=' (round 84)`);

  // 555) USER GAP #2 FOLLOW-ON (unquoted attribute-value quoting): when the user types the '=' THEMSELVES and completes a VALUE at an UNQUOTED position (Click=On|), the inserted value must be wrapped in quotes to be valid XAML (Click="OnGo_Click", not Click=OnGo_Click). This applies uniformly to every value type at an unquoted position; the whole value token is replaced (mid-token suffixes consumed). A value already inside quotes must NOT be re-quoted. Asserted on the RAW LSP wire.
  {
    // event handler at an unquoted position -> "OnGo_Click"
    const evItems = await completeItemsWith(555, pageCls("<Button Click=On|>"), "unquoted-quote-event");
    const ev = evItems.find((i) => i.label === "OnGo_Click");
    if (!ev) fail(`unquoted Click=On| should offer OnGo_Click: ${JSON.stringify(evItems.map((i) => i.label).slice(0, 20))}`);
    if (ev.textEdit?.newText !== '"OnGo_Click"') fail(`unquoted Click= must insert quoted text: ${JSON.stringify(ev.textEdit)}`);

    // enum member at an unquoted position -> "Collapsed"
    const enItems = await completeItemsWith(555, pageCls("<Button Visibility=Coll|>"), "unquoted-quote-enum");
    const en = enItems.find((i) => i.label === "Collapsed");
    if (!en) fail(`unquoted Visibility=Coll| should offer Collapsed: ${JSON.stringify(enItems.map((i) => i.label).slice(0, 20))}`);
    if (en.textEdit?.newText !== '"Collapsed"') fail(`unquoted enum value must be quoted: ${JSON.stringify(en.textEdit)}`);

    // bool at an unquoted position -> "True"
    const boItems = await completeItemsWith(555, pageCls("<Button IsEnabled=Tr|>"), "unquoted-quote-bool");
    const bo = boItems.find((i) => i.label === "True");
    if (!bo) fail(`unquoted IsEnabled=Tr| should offer True: ${JSON.stringify(boItems.map((i) => i.label).slice(0, 20))}`);
    if (bo.textEdit?.newText !== '"True"') fail(`unquoted bool value must be quoted: ${JSON.stringify(bo.textEdit)}`);

    // mid-token accept replaces the whole token (consumes the 'Xyz' suffix) -> "OnGo_Click", never with a suffix.
    const midItems = await completeItemsWith(555, pageCls("<Button Click=On|Xyz>"), "unquoted-quote-midtoken");
    const mid = midItems.find((i) => i.label === "OnGo_Click");
    if (!mid) fail(`mid-token Click=On|Xyz should offer OnGo_Click: ${JSON.stringify(midItems.map((i) => i.label).slice(0, 20))}`);
    if (mid.textEdit?.newText !== '"OnGo_Click"') fail(`mid-token accept must replace the whole token with quoted text: ${JSON.stringify(mid.textEdit)}`);

    // NEGATIVE — a value already inside quotes stays BARE (no double-quoting).
    const qItems = await completeItemsWith(555, pageCls('<Button Click="On|">'), "unquoted-quote-negative");
    const q = qItems.find((i) => i.label === "OnGo_Click");
    if (!q) fail(`quoted Click="On| should offer OnGo_Click: ${JSON.stringify(qItems.map((i) => i.label).slice(0, 20))}`);
    if (q.textEdit?.newText !== "OnGo_Click") fail(`a quoted value must NOT get extra quotes: ${JSON.stringify(q.textEdit)}`);
  }
  console.log(`[ok] unquoted value quoting (#2 follow-on): a value completed at an unquoted position (Click=On|) is wrapped in quotes (handler/enum/bool), the whole token is replaced, and a quoted value stays bare (round 85)`);

  // 547-550) GAP #4 (ux-thirdparty-xmlns): a referenced control library that registers no XmlnsDefinitionAttribute (the Windows Community Toolkit's SettingsControls, reachable ONLY via using:CommunityToolkit.WinUI.Controls) is offered in element completion; accepting one inserts a prefixed name AND auto-declares the xmlns on the root via additionalTextEdits.
  const pageToolkit = (inner) =>
    `<Page ${NS} xmlns:toolkit="using:CommunityToolkit.WinUI.Controls" x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const byNewText = (items, nt) => items.find((i) => i.textEdit?.newText === nt);
  // 547) <Sett| in a Grid offers controls:SettingsCard + controls:SettingsExpander, each injecting the xmlns.
  {
    const items = await completeItemsWith(547, pageCls("<Grid><Sett|</Grid>"), "thirdparty-offer");
    const card = byNewText(items, "controls:SettingsCard");
    if (!card) fail(`<Sett| should offer controls:SettingsCard: ${JSON.stringify(items.map((i) => i.textEdit?.newText).filter(Boolean).slice(0, 20))}`);
    if (!/CommunityToolkit\.WinUI\.Controls \(adds xmlns:controls\)/.test(card.detail || "")) fail(`detail should name the ns + injected xmlns: ${card.detail}`);
    const edits = card.additionalTextEdits;
    if (!Array.isArray(edits) || edits.length !== 1) fail(`SettingsCard should carry exactly one additionalTextEdit: ${JSON.stringify(edits)}`);
    if (edits[0].newText !== ' xmlns:controls="using:CommunityToolkit.WinUI.Controls"') fail(`the injected xmlns declaration is wrong: ${JSON.stringify(edits[0])}`);
    const r = edits[0].range;
    if (r.start.line !== r.end.line || r.start.character !== r.end.character) fail(`the xmlns injection must be a zero-width insertion: ${JSON.stringify(r)}`);
    const exp = byNewText(items, "controls:SettingsExpander");
    if (!exp) fail(`<Sett| should also offer controls:SettingsExpander`);
    if (exp.additionalTextEdits?.[0]?.newText !== ' xmlns:controls="using:CommunityToolkit.WinUI.Controls"') fail(`SettingsExpander should inject the same xmlns: ${JSON.stringify(exp.additionalTextEdits)}`);
  }
  // 548) partial filter — <SettingsC| matches SettingsCard, NOT SettingsExpander.
  {
    const items = await completeItemsWith(548, pageCls("<Grid><SettingsC|</Grid>"), "thirdparty-filter");
    const names = items.map((i) => i.textEdit?.newText).filter((t) => t && t.startsWith("controls:"));
    if (!names.includes("controls:SettingsCard")) fail(`SettingsC should match SettingsCard: ${JSON.stringify(names)}`);
    if (names.includes("controls:SettingsExpander")) fail(`SettingsC must NOT match SettingsExpander: ${JSON.stringify(names)}`);
  }
  // 549) an ALREADY-DECLARED prefix is reused with NO injection (bare detail, no additionalTextEdits).
  {
    const items = await completeItemsWith(549, pageToolkit("<Grid><Sett|</Grid>"), "thirdparty-reuse");
    const card = byNewText(items, "toolkit:SettingsCard");
    if (!card) fail(`a declared xmlns:toolkit should be reused as toolkit:SettingsCard: ${JSON.stringify(items.map((i) => i.textEdit?.newText).filter(Boolean).slice(0, 20))}`);
    if (card.additionalTextEdits && card.additionalTextEdits.length > 0) fail(`a declared prefix needs NO xmlns injection: ${JSON.stringify(card.additionalTextEdits)}`);
    if (card.detail !== "CommunityToolkit.WinUI.Controls") fail(`detail should be the bare namespace (no '(adds …)'): ${card.detail}`);
    if (byNewText(items, "controls:SettingsCard")) fail(`must not ALSO offer a generated controls: prefix when one is declared`);
  }
  // 550) NEGATIVE — non-DependencyObject referenced types (DI services) are NEVER offered as elements.
  {
    const items = await completeItemsWith(550, pageCls("<Grid><Serv|</Grid>"), "thirdparty-di-excluded");
    const di = items.filter((i) => {
      const nt = i.textEdit?.newText || "";
      return /Service(Collection|Provider|Descriptor)/.test(nt) || /DependencyInjection/.test(i.detail || "");
    });
    if (di.length > 0) fail(`DI service types must never be offered as elements: ${JSON.stringify(di.map((i) => i.textEdit?.newText))}`);
  }
  console.log(`[ok] third-party control completion (#4): toolkit controls offered with auto xmlns injection, prefix reuse, partial filter, and DI exclusion (round 84)`);

  // 551-553) GAP #3 (ux-generate-handler): the caret on an event attribute whose handler is ABSENT from the
  //          code-behind offers a "Generate event handler 'X'" quick fix whose cross-file WorkspaceEdit stubs
  //          the method into the USER .xaml.cs partial (never a generated .g.cs) with the delegate signature.
  const genOf = (actions) => actions.find((a) => a.title && a.title.startsWith("Generate event handler"));
  // 551) fresh Foo_Click -> generate action targeting SmokePage.xaml.cs with the RoutedEventHandler signature.
  {
    const actions = await codeActionAtCaret(551, pageCls(`<Button Click="Foo|_Click" Content="Hi" />`), "gen-handler");
    const gen = genOf(actions);
    if (!gen) fail(`gap #3: a missing Click handler should offer a generate action: ${JSON.stringify(actions.map((a) => a.title))}`);
    if (gen.title !== "Generate event handler 'Foo_Click'") fail(`gap #3: wrong title: ${gen.title}`);
    if (gen.kind !== "quickfix") fail(`gap #3: action must be a quickfix, got ${gen.kind}`);
    if (gen.isPreferred !== true) fail(`gap #3: action must be preferred`);
    const changes = gen.edit?.changes || {};
    const target = Object.keys(changes)[0] || "";
    if (!target.toLowerCase().endsWith("smokepage.xaml.cs")) fail(`gap #3: edit should target SmokePage.xaml.cs, got ${target}`);
    if (/\.g\.i?\.cs$/i.test(target)) fail(`gap #3: must not write to a generated partial: ${target}`);
    const newText = changes[target]?.[0]?.newText || "";
    if (!newText.includes("private void Foo_Click(object sender, RoutedEventArgs e)")) {
      fail(`gap #3: stub should carry the delegate signature, got ${JSON.stringify(newText)}`);
    }
  }
  // 552) existing OnGo_Click -> NO generate action (never regenerate an existing handler).
  {
    const actions = await codeActionAtCaret(552, pageCls(`<Button Click="OnGo|_Click" Content="Hi" />`), "gen-handler-existing");
    if (genOf(actions)) fail(`gap #3: an existing handler must not be regenerated: ${JSON.stringify(actions.map((a) => a.title))}`);
  }
  // 553) non-event attribute + markup-extension value -> NO generate action.
  {
    const nonEvent = await codeActionAtCaret(553, pageCls(`<Button Foreground="Nope|_Handler" Content="Hi" />`), "gen-handler-nonevent");
    if (genOf(nonEvent)) fail(`gap #3: a non-event attribute must not offer the fix: ${JSON.stringify(nonEvent.map((a) => a.title))}`);
    const markup = await codeActionAtCaret(554, pageCls(`<Button Click="{x:Bind Ghost|_Click}" Content="Hi" />`), "gen-handler-markup");
    if (genOf(markup)) fail(`gap #3: a markup-extension value is not a handler name: ${JSON.stringify(markup.map((a) => a.title))}`);
  }
  console.log(`[ok] generate event handler (#3): missing handler -> cross-file stub into the user code-behind; existing/non-event/markup values offer nothing`);

  // 555) A real C# change invalidates the cached Roslyn workspace. The next request must see the new
  // source member without restarting the server.
  {
    const codeBehind = resolve(dirname(XAML), "SmokePage.xaml.cs");
    const original = readFileSync(codeBehind, "utf8");
    const changed = original.replace(
      /\r?\n}\s*$/,
      `\n\n    public string WatcherAddedText { get; } = "updated";\n}\n`
    );
    let labels = [];
    let found = false;
    try {
      writeFileSync(codeBehind, changed, "utf8");
      send({
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: pathToFileURL(codeBehind).href, type: 2 }] },
      });
      const items = await completeItemsWith(
        555,
        pageCls(`<TextBlock Text="{x:Bind WatcherAdded|}" />`),
        "csharp-watch-invalidation"
      );
      labels = items.map((item) => item.label);
      found = items.some((item) => (item.textEdit?.newText || item.label) === "WatcherAddedText");
    } finally {
      writeFileSync(codeBehind, original, "utf8");
      send({
        method: "workspace/didChangeWatchedFiles",
        params: { changes: [{ uri: pathToFileURL(codeBehind).href, type: 2 }] },
      });
    }
    if (!found) {
      fail(`C# watcher invalidation did not expose WatcherAddedText: ${JSON.stringify(labels)}`);
    }
  }
  console.log(`[ok] workspace/didChangeWatchedFiles: a C# edit invalidates cached Roslyn symbols`);

  // 556) workspace/didChangeWatchedFiles null/empty-changes guard (regression): a client may send this
  // notification with an omitted, null, or empty `changes` array. The server must treat it as a no-op
  // and stay fully responsive to subsequent requests (never throw / drop the connection).
  send({ method: "workspace/didChangeWatchedFiles", params: {} }); // omitted changes
  send({ method: "workspace/didChangeWatchedFiles", params: { changes: null } }); // null changes
  send({ method: "workspace/didChangeWatchedFiles", params: { changes: [] } }); // empty changes
  {
    const stillAlive = await docSymbols(
      561,
      `<Page ${NS}>\n  <Grid>\n    <Button x:Name="WatchProbe" Content="Go" />\n  </Grid>\n</Page>`,
      "post-didChangeWatchedFiles"
    );
    if (stillAlive.length !== 1) fail(`server unresponsive after null/empty didChangeWatchedFiles, got ${stillAlive.length} symbols`);
    if (!stillAlive[0].name.includes("Page")) fail(`unexpected outline after didChangeWatchedFiles guard: '${stillAlive[0].name}'`);
  }
  console.log(`[ok] workspace/didChangeWatchedFiles: omitted/null/empty changes are a no-op; server stays responsive`);

  // 562) workspace-trust boundary (behavioral negative): a document OUTSIDE every allowedRoot must be served project-less — the server must NOT reach the project resolver / MSBuild for it. We open a real .xaml under the OS temp dir (guaranteed outside the fixture root that was passed as the only allowedRoot) with an x:Class + event handler, and assert F12 on the handler yields NO location. The in-root fixture DID resolve earlier (definition #2 landed in the code-behind), so a null here proves the boundary gates resolution rather than the feature being globally broken. A sibling .csproj + code-behind are written next to it so FindOwningProject WOULD discover a project (and F12 could land) if the gate were bypassed — making the null result attributable to the gate, not to an absent project. These are only ever loaded on a bypass, so the passing path never touches MSBuild.
  {
    const outDir = mkdtempSync(join(tmpdir(), "winui-xaml-oob-"));
    const outFile = join(outDir, "OutOfRootPage.xaml");
    const outText =
      `<Page x:Class="OutOfRoot.OutOfRootPage" ${NS}>\n` +
      `  <Grid>\n` +
      `    <Button x:Name="OobButton" Click="OnOobClick" Content="Go" />\n` +
      `  </Grid>\n` +
      `</Page>\n`;
    try {
      writeFileSync(outFile, outText, "utf8");
      // Give the out-of-root file genuine project-discovery affordance: absent the trust gate,
      // FindOwningProject would find this .csproj and F12 could resolve into the code-behind.
      writeFileSync(
        join(outDir, "OutOfRoot.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net10.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`,
        "utf8"
      );
      writeFileSync(
        join(outDir, "OutOfRootPage.xaml.cs"),
        `namespace OutOfRoot { public partial class OutOfRootPage { public void OnOobClick(object sender, object e) { } } }\n`,
        "utf8"
      );
      const outUri = pathToFileURL(outFile).href;
      const handlerAt = outText.indexOf("OnOobClick") + 3;
      const outCaret = offsetToPosition(outText, handlerAt);

      send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri: outUri, languageId: "xaml", version: 1, text: outText } },
      });
      send({
        id: 561,
        method: "textDocument/definition",
        params: { textDocument: { uri: outUri }, position: outCaret },
      });
      const oobDef = await waitFor(responseFor(561), 30000, "out-of-root definition");
      if (oobDef.error) fail(`out-of-root definition errored: ${JSON.stringify(oobDef.error)}`);
      const oobLoc = Array.isArray(oobDef.result) ? oobDef.result[0] : oobDef.result;
      if (oobLoc && oobLoc.uri) {
        fail(`out-of-root document was project-resolved (boundary bypass): ${JSON.stringify(oobLoc)}`);
      }
      send({ method: "textDocument/didClose", params: { textDocument: { uri: outUri } } });
    } finally {
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  console.log(`[ok] workspace-trust boundary: an out-of-root .xaml (with a sibling project) is served project-less (F12 handler -> no location), while the in-root fixture resolved`);

}
