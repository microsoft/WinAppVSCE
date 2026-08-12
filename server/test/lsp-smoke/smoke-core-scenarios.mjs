export async function runCoreScenarios(ctx) {
  const {
    fail, xamlText, xamlUri, XAML, NS, EXPECTED_CODE_BEHIND,
    EXPECTED_GREETING_LINE, completeWith, completeItemsWith, hoverAt,
    definitionWith, codeActionAtCaret, referencesWith, highlightWith,
    send, waitFor, responseFor, nextVersion, resCaret,
  } = ctx;

  const emptyElementLabels = await completeWith(5, `<Page ${NS}>\n  <|\n</Page>`, "element-name-empty");
  for (const want of ["Button", "TextBlock", "TitleBar"]) {
    if (!emptyElementLabels.includes(want)) fail(`empty element completion missing '${want}' (got ${emptyElementLabels.length} items)`);
  }
  console.log(`[ok] completion(element): '<' -> Button/TextBlock/TitleBar (${emptyElementLabels.length} items)`);

  const elementLabels = await completeWith(6, `<Page ${NS}>\n  <But|\n</Page>`, "element-name");
  for (const want of ["Button"]) {
    if (!elementLabels.includes(want)) fail(`element completion missing '${want}' (got ${elementLabels.length} items)`);
  }
  console.log(`[ok] completion(element): '<But' -> Button (${elementLabels.length} items)`);

  const attrLabels = await completeWith(7, `<Page ${NS}>\n  <Button |\n</Page>`, "attribute-name");
  for (const want of ["Content", "Click", "IsEnabled", "x:Name", "AutomationProperties.Name"]) {
    if (!attrLabels.includes(want)) fail(`attribute completion missing '${want}' (got ${attrLabels.length} items)`);
  }
  console.log(`[ok] completion(attribute): '<Button ' -> members, x:Name, and AutomationProperties.Name (${attrLabels.length} items)`);

  const newlineAttrLabels = await completeWith(8, `<Page ${NS}>\n  <Button\n    |\n</Page>`, "attribute-name-newline");
  for (const want of ["Content", "x:Name", "AutomationProperties.Name"]) {
    if (!newlineAttrLabels.includes(want)) fail(`newline attribute completion missing '${want}' (got ${newlineAttrLabels.length} items)`);
  }
  console.log(`[ok] completion(attribute newline): an empty indented line inside <Button> offers attributes (${newlineAttrLabels.length} items)`);

  const attachedLabels = await completeWith(9, `<Page ${NS}>\n  <Button Grid.|\n</Page>`, "attached-property");
  for (const want of ["Grid.Row", "Grid.Column"]) {
    if (!attachedLabels.includes(want)) fail(`attached-property completion missing '${want}' (got ${attachedLabels.length} items)`);
  }
  console.log(`[ok] completion(attached): '<Button Grid.' -> Grid.Row/Grid.Column (${attachedLabels.length} items)`);

  // 9) value completion: enum-typed attribute -> enum members.
  const enumLabels = await completeWith(10, `<Page ${NS}>\n  <Button HorizontalAlignment="|" />\n</Page>`, "enum-value");
  for (const want of ["Left", "Center", "Right", "Stretch"]) {
    if (!enumLabels.includes(want)) fail(`enum value completion missing '${want}' (got ${enumLabels.join(",")})`);
  }
  console.log(`[ok] completion(enum): 'HorizontalAlignment="' -> Left/Center/Right/Stretch (${enumLabels.length} items)`);

  // 10) value completion: enum members filter by the partial already typed.
  const enumPartial = await completeWith(11, `<Page ${NS}>\n  <Button HorizontalAlignment="C|" />\n</Page>`, "enum-value-partial");
  if (!enumPartial.includes("Center")) fail(`enum partial completion missing 'Center' (got ${enumPartial.join(",")})`);
  if (enumPartial.includes("Left")) fail(`enum partial completion should have filtered out 'Left' (got ${enumPartial.join(",")})`);
  console.log(`[ok] completion(enum, partial 'C'): -> Center, not Left (${enumPartial.length} items)`);

  // 11) value completion: boolean-typed attribute -> True/False.
  const boolLabels = await completeWith(12, `<Page ${NS}>\n  <Button IsEnabled="|" />\n</Page>`, "bool-value");
  for (const want of ["True", "False"]) {
    if (!boolLabels.includes(want)) fail(`bool value completion missing '${want}' (got ${boolLabels.join(",")})`);
  }
  console.log(`[ok] completion(bool): 'IsEnabled="' -> True/False (${boolLabels.length} items)`);

  // 12) x:Bind member-path completion: members of the page's x:Class (SmokePage), filtered by partial.
  //     Doctored documents retain x:Class so resolution follows the in-memory document.
  const bindLabels = await completeWith(20, `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind Gre|}" />\n</Page>`, "bind-path");
  if (!bindLabels.includes("GreetingText")) fail(`x:Bind path completion missing 'GreetingText' (got ${bindLabels.join(",")})`);
  if (bindLabels.includes("Items")) fail(`x:Bind path completion with partial 'Gre' should have filtered out 'Items' (got ${bindLabels.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Gre'): -> GreetingText, not Items (${bindLabels.length} items)`);

  // 13) x:Bind with an empty path -> all bindable members of the page.
  const bindAll = await completeWith(21, `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind |}" />\n</Page>`, "bind-path-empty");
  for (const want of ["GreetingText", "Items"]) {
    if (!bindAll.includes(want)) fail(`x:Bind empty-path completion missing '${want}' (got ${bindAll.length} items)`);
  }
  console.log(`[ok] completion(x:Bind, ''): -> GreetingText + Items (${bindAll.length} items)`);

  // 14) x:Bind dotted path -> members of the leading segment's type. Items is IReadOnlyList<string>,
  //     so 'Items.' must surface Count (found by walking the interface's inherited interfaces).
  const bindDotted = await completeWith(22, `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind Items.C|}" />\n</Page>`, "bind-path-dotted");
  if (!bindDotted.includes("Count")) fail(`x:Bind dotted-path completion missing 'Count' (got ${bindDotted.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Items.C'): -> Count (${bindDotted.length} items)`);

  // 14a) element completion inside a collection property element is scoped to the collection's item
  //      type: <Grid.RowDefinitions> offers RowDefinition, not the full control list.
  const propChild = await completeWith(43, `<Page ${NS}>\n  <Grid>\n    <Grid.RowDefinitions>\n      <|\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`, "property-element-child");
  if (!propChild.includes("RowDefinition")) fail(`property-element child completion missing 'RowDefinition' (got ${propChild.slice(0, 40).join(",")})`);
  if (propChild.includes("Button")) fail(`property-element child completion should be scoped to RowDefinition, not offer 'Button' (got ${propChild.length} items)`);
  console.log(`[ok] completion(property element): '<Grid.RowDefinitions><' -> RowDefinition, scoped (${propChild.length} items)`);

  // 14b) nested markup extension: {Binding Source={StaticResource |}} completes resource keys for the
  //      INNER StaticResource, not the outer Binding.
  const nestedRes = await completeWith(44, `<Page ${NS}>\n  <Border Tag="{Binding Source={StaticResource |}}" />\n</Page>`, "nested-resource");
  if (!nestedRes.includes("SmokeAccentBrush")) fail(`nested StaticResource completion missing 'SmokeAccentBrush' (got ${nestedRes.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(nested markup): '{Binding Source={StaticResource ' -> SmokeAccentBrush (${nestedRes.length} items)`);

  // 14c) element completion inside a CDATA section is suppressed (no leak of element names).
  const cdataItems = await completeWith(45, `<Page ${NS}>\n  <Grid>\n    <![CDATA[ <But| ]]>\n  </Grid>\n</Page>`, "cdata-suppression");
  if (cdataItems.includes("Button")) fail(`completion inside CDATA must not offer 'Button' (got ${cdataItems.slice(0, 20).join(",")})`);
  console.log(`[ok] completion(cdata): '<![CDATA[ <But' -> no element completions (${cdataItems.length} items)`);

  // 15) Style/ControlTemplate authoring completion (VS parity).
  const pageRes = (inner) => `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    ${inner}\n  </Page.Resources>\n</Page>`;

  // 15a) <Style TargetType="|"> completes type names (incl. alphabetically-late ones like TextBlock).
  const styleTt = await completeWith(46, pageRes(`<Style TargetType="|">\n      <Setter Property="Content" Value="Go" />\n    </Style>`), "style-targettype");
  if (!styleTt.includes("Button")) fail(`Style.TargetType completion missing 'Button' (got ${styleTt.length} items)`);
  if (!styleTt.includes("TextBlock")) fail(`Style.TargetType completion missing 'TextBlock' (dropped by item cap?) (got ${styleTt.length} items)`);
  console.log(`[ok] completion(Style.TargetType): '<Style TargetType="' -> Button + TextBlock (${styleTt.length} items)`);

  // 15b) <Setter Property="|"> completes settable properties of the enclosing TargetType.
  const setterProp = await completeWith(47, pageRes(`<Style TargetType="Button">\n      <Setter Property="|" Value="Go" />\n    </Style>`), "setter-property");
  if (!setterProp.includes("Content")) fail(`Setter.Property completion missing Button 'Content' (got ${setterProp.slice(0, 40).join(",")})`);
  if (!setterProp.includes("IsEnabled")) fail(`Setter.Property completion missing Button 'IsEnabled'`);
  if (setterProp.includes("Button")) fail(`Setter.Property should offer properties, not types (unexpected 'Button')`);
  console.log(`[ok] completion(Setter.Property): '<Setter Property="' -> Content/IsEnabled scoped to Button (${setterProp.length} items)`);

  // 15c) <ControlTemplate TargetType="|"> completes type names.
  const ctTt = await completeWith(48, pageRes(`<ControlTemplate TargetType="|">\n      <Grid />\n    </ControlTemplate>`), "controltemplate-targettype");
  if (!ctTt.includes("Button")) fail(`ControlTemplate.TargetType completion missing 'Button' (got ${ctTt.length} items)`);
  console.log(`[ok] completion(ControlTemplate.TargetType): -> Button (${ctTt.length} items)`);

  // 16) Round-4 regressions: Setter.Value enum/bool, TemplateBinding, TargetType F12, Setter.Property hover.
  const dLocal = 'xmlns:local="using:SmokeFixture"';
  const sv1 = await completeWith(95, pageRes(`<Style TargetType="Button">\n      <Setter Property="HorizontalAlignment" Value="|" />\n    </Style>`), "setterval-enum");
  for (const want of ["Center", "Stretch"]) {
    if (!sv1.includes(want)) fail(`Setter.Value(enum) missing '${want}' (got ${sv1.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value enum): -> Center/Stretch (${sv1.length} items)`);

  const sv2 = await completeWith(96, pageRes(`<Style TargetType="Button">\n      <Setter Property="IsEnabled" Value="|" />\n    </Style>`), "setterval-bool");
  for (const want of ["True", "False"]) {
    if (!sv2.includes(want)) fail(`Setter.Value(bool) missing '${want}' (got ${sv2.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value bool): -> True/False (${sv2.length} items)`);

  const tb = await completeWith(97, pageRes(`<ControlTemplate TargetType="Button">\n      <ContentPresenter Content="{TemplateBinding |}" />\n    </ControlTemplate>`), "templatebinding");
  for (const want of ["Content", "IsEnabled"]) {
    if (!tb.includes(want)) fail(`TemplateBinding completion missing '${want}' (got ${tb.length} items)`);
  }
  console.log(`[ok] completion(TemplateBinding): -> Content/IsEnabled (${tb.length} items)`);

  const ttDef = await definitionWith(98, `<Page ${NS} x:Class="SmokeFixture.SmokePage" ${dLocal}>\n  <Page.Resources>\n    <Style TargetType="local:Smoke|Page">\n      <Setter Property="DataContext" Value="{x:Null}" />\n    </Style>\n  </Page.Resources>\n</Page>`, "targettype-f12");
  if (!ttDef?.uri || !ttDef.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`TargetType F12 did not land on SmokePage.xaml.cs (got ${ttDef?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(TargetType user type): local:SmokePage -> SmokePage.xaml.cs`);

  const spHover = await hoverAt(99, pageRes(`<Style TargetType="Button">\n      <Setter Property="Cont|ent" Value="Go" />\n    </Style>`), "setterprop-hover");
  if (!/Content/.test(spHover) || !/ContentControl/.test(spHover)) {
    fail(`Setter.Property hover did not resolve to ContentControl.Content (got ${JSON.stringify(spHover)})`);
  }
  console.log(`[ok] hover(Setter.Property): Content -> ContentControl.Content`);

  // 17) Round-5 regressions: RelativeSource arg-name/Mode, event-handler value, x:DataType F12.
  const pageCls = (inner) => `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const rs1 = await completeWith(190, pageCls(`<Border Tag="{RelativeSource |}" />`), "relativesource-argname");
  if (!rs1.includes("Mode")) fail(`RelativeSource arg-name completion missing 'Mode' (got ${rs1.join(",")})`);
  console.log(`[ok] completion(RelativeSource arg name): -> Mode (${rs1.length} items)`);

  const rs2 = await completeWith(191, pageCls(`<Border Tag="{RelativeSource Mode=|}" />`), "relativesource-mode");
  for (const want of ["Self", "TemplatedParent"]) {
    if (!rs2.includes(want)) fail(`RelativeSource Mode completion missing '${want}' (got ${rs2.join(",")})`);
  }
  if (rs2.includes("OneWay")) fail(`RelativeSource Mode wrongly offered BindingMode value 'OneWay' (got ${rs2.join(",")})`);
  console.log(`[ok] completion(RelativeSource Mode): -> Self/TemplatedParent, not BindingMode (${rs2.length} items)`);

  const rs3 = await completeWith(192, pageCls(`<Border Tag="{Binding RelativeSource={RelativeSource Mode=|}}" />`), "relativesource-nested");
  for (const want of ["Self", "TemplatedParent"]) {
    if (!rs3.includes(want)) fail(`nested RelativeSource Mode completion missing '${want}' (got ${rs3.join(",")})`);
  }
  console.log(`[ok] completion(RelativeSource Mode, nested in Binding): -> Self/TemplatedParent (${rs3.length} items)`);

  const ev = await completeWith(193, pageCls(`<Button Click="|" />`), "event-handler");
  if (!ev.includes("OnGo_Click")) fail(`event-handler completion missing 'OnGo_Click' (got ${ev.join(",")})`);
  console.log(`[ok] completion(event handler Click=): -> OnGo_Click (${ev.length} items)`);

  const dtDef = await definitionWith(194, `<Page ${NS} ${dLocal}>\n  <ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Smoke|Page">\n        <TextBlock />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>\n</Page>`, "datatype-f12");
  if (!dtDef?.uri || !dtDef.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`x:DataType F12 did not land on SmokePage.xaml.cs (got ${dtDef?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:DataType user type): local:SmokePage -> SmokePage.xaml.cs`);

  // Regression: x:Bind Mode= still resolves BindingMode (no extension type).
  const modeBind = await completeWith(195, pageCls(`<TextBlock Text="{x:Bind GreetingText, Mode=|}" />`), "xbind-mode");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeBind.includes(want)) fail(`x:Bind Mode completion missing BindingMode '${want}' (got ${modeBind.join(",")})`);
  }
  console.log(`[ok] completion(x:Bind Mode): -> BindingMode preserved (${modeBind.length} items)`);

  // 18) Round-6 regressions: x:Bind method completion (private handlers), DataTemplate x:DataType scoping.
  const pageClsLocal = (inner) => `<Page ${NS} ${dLocal} x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const b1 = await completeWith(200, pageCls(`<Button Click="{x:Bind |}" />`), "xbind-event-page");
  if (!b1.includes("OnGo_Click")) fail(`x:Bind event completion (page) missing private 'OnGo_Click' (got ${b1.length} items)`);
  console.log(`[ok] completion(x:Bind event, page class): -> OnGo_Click (private handler surfaced, ${b1.length} items)`);

  const b2 = await completeWith(201, pageClsLocal(`<ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Page2">\n        <Button Click="{x:Bind |}" />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>`), "xbind-event-template");
  if (!b2.includes("OnBack_Click")) fail(`x:Bind event completion (Page2 template) missing 'OnBack_Click' (got ${b2.length} items)`);
  if (b2.includes("OnGo_Click")) fail(`x:Bind in Page2 template wrongly offered SmokePage's 'OnGo_Click' (bad x:DataType scoping)`);
  console.log(`[ok] completion(x:Bind event, Page2 x:DataType): -> OnBack_Click, not SmokePage.OnGo_Click (${b2.length} items)`);

  const b3 = await definitionWith(202, pageClsLocal(`<ItemsRepeater>\n    <ItemsRepeater.ItemTemplate>\n      <DataTemplate x:DataType="local:Page2">\n        <Button Click="{x:Bind OnBack|_Click}" />\n      </DataTemplate>\n    </ItemsRepeater.ItemTemplate>\n  </ItemsRepeater>`), "xbind-f12-template");
  if (!b3?.uri || !b3.uri.endsWith("Page2.xaml.cs")) {
    fail(`x:Bind F12 in Page2 template did not land on Page2.xaml.cs (got ${b3?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:Bind method, Page2 x:DataType): OnBack_Click -> Page2.xaml.cs`);

  // 18b) ROUND 76: a classic {Binding ElementName=Foo, Path=…} completes the NAMED element's members
  // (rooted at that element's TYPE), not the DataContext — previously it declined and offered nothing.
  const enBox = (path) => pageCls(`<StackPanel>\n    <TextBox x:Name="myBox" />\n    <TextBlock Text="${path}" />\n  </StackPanel>`);
  const en1 = await completeWith(503, enBox("{Binding ElementName=myBox, Path=|}"), "binding-elementname-path");
  for (const want of ["Text", "IsEnabled"]) {
    if (!en1.includes(want)) fail(`{Binding ElementName=myBox, Path=} should offer TextBox member '${want}' (got ${en1.slice(0, 40).join(",")})`);
  }
  if (en1.includes("GreetingText")) fail(`{Binding ElementName=myBox} must root at the TextBox, NOT the page DataContext (leaked 'GreetingText')`);
  console.log(`[ok] completion({Binding ElementName=myBox, Path=}): TextBox members, not page DataContext (${en1.length} items)`);

  // 18b-ii) a dotted path walks from the named element's member type (Text : string).
  const en2 = await completeWith(504, enBox("{Binding ElementName=myBox, Path=Text.|}"), "binding-elementname-dotted");
  if (!en2.includes("Length")) fail(`{Binding ElementName=myBox, Path=Text.} should offer string member 'Length' (got ${en2.slice(0, 40).join(",")})`);
  if (en2.includes("IsEnabled")) fail(`dotted path into Text:string must NOT still offer TextBox 'IsEnabled' (got ${en2.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding ElementName=myBox, Path=Text.}): string members, walked past TextBox (${en2.length} items)`);

  // 18b-iii) an unknown ElementName resolves to no type -> no members (never guesses).
  const en3 = await completeWith(505, enBox("{Binding ElementName=ghost, Path=|}"), "binding-elementname-unknown");
  if (en3.includes("Text") || en3.includes("IsEnabled")) fail(`unknown ElementName must offer no members (got ${en3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding ElementName=ghost}): unknown element -> no members (${en3.length} items)`);

  // 18b-iv) a Source=/RelativeSource= redirect still declines (its target type isn't statically known here).
  const en4 = await completeWith(506, enBox("{Binding RelativeSource={RelativeSource Self}, Path=|}"), "binding-relativesource-declines");
  if (en4.includes("Text") || en4.includes("IsEnabled")) fail(`RelativeSource binding must still decline path completion (got ${en4.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding RelativeSource=…, Path=}): declines (unchanged) (${en4.length} items)`);

  // 18b-v) PRECEDENCE: a Source= redirector wins over a co-present ElementName= in BOTH arg orders
  // (the source's target type isn't statically known, so path completion must still decline).
  const enBoxAfter = (path) => pageCls(`<StackPanel>\n    <TextBlock Text="${path}" />\n    <TextBox x:Name="myBox" />\n  </StackPanel>`);
  const en5 = await completeWith(507, enBox("{Binding ElementName=myBox, Source={StaticResource SmokeAccentBrush}, Path=|}"), "binding-elementname-source-precedence");
  if (en5.includes("Text") || en5.includes("IsEnabled")) fail(`Source= must win over ElementName= (ElementName first): expected decline, got ${en5.slice(0, 40).join(",")}`);
  const en6 = await completeWith(508, enBox("{Binding Source={StaticResource SmokeAccentBrush}, ElementName=myBox, Path=|}"), "binding-source-elementname-precedence");
  if (en6.includes("Text") || en6.includes("IsEnabled")) fail(`Source= must win over ElementName= (Source first): expected decline, got ${en6.slice(0, 40).join(",")}`);
  console.log(`[ok] completion({Binding ElementName=…, Source=…, Path=}): Source wins -> declines in both orders`);

  // 18b-vi) FORWARD REFERENCE: the named element declared AFTER the binding still roots the path
  // (x:Name scope is the whole page, so ElementName resolution is order-independent).
  const en7 = await completeWith(509, enBoxAfter("{Binding ElementName=myBox, Path=|}"), "binding-elementname-forward-ref");
  for (const want of ["Text", "IsEnabled"]) {
    if (!en7.includes(want)) fail(`forward-referenced ElementName should offer TextBox member '${want}' (got ${en7.slice(0, 40).join(",")})`);
  }
  if (en7.includes("GreetingText")) fail(`forward-referenced ElementName must root at the TextBox, not the page (leaked 'GreetingText')`);
  console.log(`[ok] completion({Binding ElementName=myBox} declared after the binding): roots at the TextBox (${en7.length} items)`);

  // 18b-vii) a BARE POSITIONAL first arg that happens to be named like a redirector is a PATH, not a
  // redirector: {Binding Source} rooted at an Image x:DataType completes Image.Source (round-51 guard).
  const tmplImg = (path) => pageCls(`<ListView>\n    <ListView.ItemTemplate>\n      <DataTemplate x:DataType="Image">\n        <TextBlock Text="${path}" />\n      </DataTemplate>\n    </ListView.ItemTemplate>\n  </ListView>`);
  const en8 = await completeWith(510, tmplImg("{Binding Source|}"), "binding-bare-positional-source");
  if (!en8.includes("Source")) fail(`bare positional {Binding Source} should complete Image.Source as a path (got ${en8.slice(0, 40).join(",")})`);
  console.log(`[ok] completion({Binding Source} in Image template): bare positional is a path, not Source= (${en8.length} items)`);

  // 18c) ROUND 77: Storyboard.TargetProperty parenthesized (Owner.Property) qualifiers complete the
  // EXPLICIT owner type's members (instance DP + attached), independently of Storyboard.TargetName.
  const sb = (tp) => pageCls(`<StackPanel>\n    <Border x:Name="AttachedProbe" />\n    <Storyboard>\n      <DoubleAnimation Storyboard.TargetName="AttachedProbe" Storyboard.TargetProperty="${tp}" />\n    </Storyboard>\n  </StackPanel>`);
  // (i) instance DP of an explicit owner: (UIElement.Opac -> Opacity.
  const sp1 = await completeWith(511, sb("(UIElement.Opac|"), "sb-paren-instance-dp");
  if (!sp1.includes("Opacity")) fail(`(UIElement.Opac should complete instance DP 'Opacity' (got ${sp1.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.Opac'): -> Opacity (${sp1.length} items)`);
  // (ii) attached properties of an explicit owner: (Canvas. -> Left/Top/ZIndex.
  const sp2 = await completeWith(512, sb("(Canvas.|"), "sb-paren-attached");
  for (const want of ["Left", "Top"]) {
    if (!sp2.includes(want)) fail(`(Canvas. should complete attached property '${want}' (got ${sp2.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '(Canvas.'): -> attached Left/Top (${sp2.length} items)`);
  // (iii) attached filter: (Canvas.Le -> Left only, not Top.
  const sp3 = await completeWith(513, sb("(Canvas.Le|"), "sb-paren-attached-filter");
  if (!sp3.includes("Left")) fail(`(Canvas.Le should complete 'Left' (got ${sp3.slice(0, 40).join(",")})`);
  if (sp3.includes("Top")) fail(`(Canvas.Le should filter OUT 'Top' (got ${sp3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(Canvas.Le'): -> Left only (${sp3.length} items)`);
  // (iv) chained transform group: (UIElement.RenderTransform).(CompositeTransform.Trans -> TranslateX/Y.
  const sp4 = await completeWith(514, sb("(UIElement.RenderTransform).(CompositeTransform.Trans|"), "sb-paren-chained");
  if (!sp4.includes("TranslateX")) fail(`chained (…).(CompositeTransform.Trans should complete 'TranslateX' (got ${sp4.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty chained CompositeTransform.Trans): -> TranslateX (${sp4.length} items)`);
  // (v) simple (non-parenthesized) path still roots at the TargetName element (regression): Border.Opac.
  const sp5 = await completeWith(515, sb("Opac|"), "sb-simple-roots-at-target");
  if (!sp5.includes("Opacity")) fail(`simple TargetProperty 'Opac' should root at the Border target -> 'Opacity' (got ${sp5.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty simple 'Opac'): roots at target element (${sp5.length} items)`);
  // (vi) an unknown owner type in the group offers nothing (never the element's members).
  const sp6 = await completeWith(516, sb("(NoSuchOwner.|"), "sb-paren-unknown-owner");
  if (sp6.includes("Opacity") || sp6.includes("Width")) fail(`unknown owner type must offer no members (got ${sp6.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(NoSuchOwner.'): unknown owner -> no members (${sp6.length} items)`);

  // (vii) bare "(Owner." with an empty member partial merges the owner's instance DPs AND attached props.
  const sp7 = await completeWith(517, sb("(UIElement.|"), "sb-paren-bare-owner");
  for (const want of ["Opacity", "RenderTransform"]) {
    if (!sp7.includes(want)) fail(`(UIElement. should merge instance DP '${want}' (got ${sp7.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.'): merged instance+attached (${sp7.length} items)`);
  // (viii) a leading-space owner token is trimmed and still resolves ("( Canvas." -> attached Left/Top).
  const sp8 = await completeWith(518, sb("( Canvas.|"), "sb-paren-ws-owner");
  for (const want of ["Left", "Top"]) {
    if (!sp8.includes(want)) fail(`( Canvas. (leading space) should trim + resolve -> attached '${want}' (got ${sp8.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(Storyboard.TargetProperty '( Canvas.'): trimmed owner resolves (${sp8.length} items)`);
  // (ix) a dotted sub-path into the ABSTRACT Transform type is benign-empty — never jumps back to the owner
  // (no 'Opacity') and never leaks page members (no 'GreetingText'); the concrete tail uses the ").(Cast." form.
  const sp9 = await completeWith(519, sb("(UIElement.RenderTransform.|"), "sb-paren-dotted-abstract");
  if (sp9.includes("Opacity")) fail(`(UIElement.RenderTransform. must not jump back to UIElement members (got ${sp9.slice(0, 40).join(",")})`);
  if (sp9.includes("GreetingText")) fail(`(UIElement.RenderTransform. must not leak page members (got ${sp9.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty '(UIElement.RenderTransform.'): benign sub-path (${sp9.length} items)`);

  // 18d) ROUND 78: document-local author keys are conservatively type-scoped by their DECLARING element's
  // type (VS parity — the round-74 follow-on), while App.xaml keys and un-resolvable declarations stay
  // always-offered so an author's own key is never wrongly hidden.
  const authorRes =
    `<SolidColorBrush x:Key="MyDocBrush" Color="Red" />\n` +
    `    <Style x:Key="MyDocStyle" TargetType="Button" />\n` +
    `    <x:Double x:Key="MyDocNum">12</x:Double>`;
  const pageAuthor = (attr) =>
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n    ${authorRes}\n  </Page.Resources>\n  <Grid ${attr} />\n</Page>`;
  // (i) On a Brush property: the author Brush + the App.xaml Brush show; the author Style is HIDDEN, and
  // the intrinsic x:Double is HIDDEN too (ResolveElementType maps x:Double -> System.Double, so it is
  // correctly type-scoped away from a Brush — VS parity, not a false-hide: it shows on a double property).
  const ak1 = await completeWith(520, pageAuthor('Background="{StaticResource |}"'), "author-key-on-brush");
  if (!ak1.includes("MyDocBrush")) fail(`author Brush key should show on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  if (!ak1.includes("SmokeAccentBrush")) fail(`App.xaml Brush key should always show (got ${ak1.slice(0, 40).join(",")})`);
  if (ak1.includes("MyDocStyle")) fail(`author Style key must be HIDDEN on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  if (ak1.includes("MyDocNum")) fail(`author x:Double key must be HIDDEN on a Brush property (got ${ak1.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on Brush): MyDocBrush+SmokeAccentBrush, Style+Double hidden (${ak1.length} items)`);
  // (ii) On a Style property: the author Style shows; the doc-local Brush is HIDDEN. The App.xaml Brush key
  // stays SHOWN — App keys carry no declaring element here, so they are conservatively always-offered.
  const ak2 = await completeWith(521, pageAuthor('Style="{StaticResource |}"'), "author-key-on-style");
  if (!ak2.includes("MyDocStyle")) fail(`author Style key should show on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (ak2.includes("MyDocBrush")) fail(`doc-local Brush key must be HIDDEN on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (ak2.includes("MyDocNum")) fail(`doc-local x:Double key must be HIDDEN on a Style property (got ${ak2.slice(0, 40).join(",")})`);
  if (!ak2.includes("SmokeAccentBrush")) fail(`App.xaml key must stay offered on a Style property (always-offered) (got ${ak2.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on Style): MyDocStyle shown, doc-local Brush/Double hidden, App key always-offered (${ak2.length} items)`);
  // (iii) On a double property (Width): the intrinsic x:Double shows; the Brush and Style keys are HIDDEN —
  // proving the intrinsic IS collected and correctly type-matched (not merely dropped everywhere).
  const ak3 = await completeWith(522, pageAuthor('Width="{StaticResource |}"'), "author-key-on-double");
  if (!ak3.includes("MyDocNum")) fail(`intrinsic x:Double key should show on a double property (got ${ak3.slice(0, 40).join(",")})`);
  if (ak3.includes("MyDocBrush")) fail(`author Brush key must be HIDDEN on a double property (got ${ak3.slice(0, 40).join(",")})`);
  if (ak3.includes("MyDocStyle")) fail(`author Style key must be HIDDEN on a double property (got ${ak3.slice(0, 40).join(",")})`);
  console.log(`[ok] completion(author key on double Width): x:Double MyDocNum shown, Brush/Style hidden (${ak3.length} items)`);
  // (iv) On an 'object' property (Tag) every author key is offered — no scoping when the target is object.
  const ak4 = await completeWith(523, pageAuthor('Tag="{StaticResource |}"'), "author-key-on-object");
  for (const want of ["MyDocBrush", "MyDocStyle", "MyDocNum", "SmokeAccentBrush"]) {
    if (!ak4.includes(want)) fail(`object 'Tag' property should offer every author key incl '${want}' (got ${ak4.slice(0, 40).join(",")})`);
  }
  console.log(`[ok] completion(author key on object Tag): all author keys offered (${ak4.length} items)`);


  // 14a) x:Bind via the named Path= argument resolves the same members as the positional form.
  const bindNamedPath = await completeWith(40, `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind Path=Gre|}" />\n</Page>`, "bind-named-path");
  if (!bindNamedPath.includes("GreetingText")) fail(`x:Bind named-Path completion missing 'GreetingText' (got ${bindNamedPath.join(",")})`);
  if (bindNamedPath.includes("Items")) fail(`x:Bind named-Path 'Gre' should filter out 'Items' (got ${bindNamedPath.join(",")})`);
  console.log(`[ok] completion(x:Bind, 'Path=Gre'): -> GreetingText, not Items (${bindNamedPath.length} items)`);

  // 14a-ii) F12 through the named Path= argument lands on the same member as the positional form.
  const bindNamedDef = await definitionWith(41, `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind Path=Greeting|Text}" />\n</Page>`, "bind-named-path");
  if (!bindNamedDef || !bindNamedDef.uri) fail(`x:Bind named-Path definition returned no location: ${JSON.stringify(bindNamedDef)}`);
  if (!bindNamedDef.uri.toLowerCase().endsWith(EXPECTED_CODE_BEHIND)) fail(`x:Bind named-Path definition landed in unexpected file: ${bindNamedDef.uri}`);
  if (bindNamedDef.range?.start?.line !== EXPECTED_GREETING_LINE) fail(`x:Bind named-Path definition landed on line ${bindNamedDef.range?.start?.line}, expected ${EXPECTED_GREETING_LINE}`);
  console.log(`[ok] definition: {x:Bind Path=GreetingText} -> ${bindNamedDef.uri} @ line ${bindNamedDef.range.start.line}`);

  // 14a-iii) element completion inside an XML comment is suppressed (no leak of element names).
  const commentItems = await completeWith(42, `<Page ${NS}>\n  <Grid>\n    <!-- <But| -->\n  </Grid>\n</Page>`, "comment-suppression");
  if (commentItems.includes("Button")) fail(`completion inside an XML comment must not offer 'Button' (got ${commentItems.slice(0, 20).join(",")})`);
  console.log(`[ok] completion(comment): '<!-- <But' -> no element completions (${commentItems.length} items)`);

  // 14b) markup-extension NAME completion: typing '{' (or a partial name) offers the extensions.
  const markupAll = await completeWith(23, `<Page ${NS}>\n  <TextBlock Text="{|}" />\n</Page>`, "markup-name");
  for (const want of ["x:Bind", "Binding", "StaticResource", "ThemeResource"]) {
    if (!markupAll.includes(want)) fail(`markup-name completion missing '${want}' (got ${markupAll.join(",")})`);
  }
  console.log(`[ok] completion(markup, '{'): -> x:Bind/Binding/StaticResource/... (${markupAll.length} items)`);

  // 14c) partial name filters to matching extensions and does NOT eagerly list x:Bind members.
  const markupStatic = await completeWith(24, `<Page ${NS}>\n  <TextBlock Text="{Stat|}" />\n</Page>`, "markup-name-partial");
  if (!markupStatic.includes("StaticResource")) fail(`markup-name 'Stat' should offer StaticResource (got ${markupStatic.join(",")})`);
  if (markupStatic.includes("GreetingText")) fail(`markup-name 'Stat' must not list x:Bind members (got ${markupStatic.join(",")})`);
  console.log(`[ok] completion(markup, 'Stat'): -> StaticResource, no bind members (${markupStatic.length} items)`);

  // 14d) Mode= named argument -> BindingMode enum members (shared by x:Bind and Binding).
  const modeAll = await completeWith(25, `<Page ${NS}>\n  <TextBlock Text="{x:Bind GreetingText, Mode=|}" />\n</Page>`, "markup-arg-Mode");
  for (const want of ["OneWay", "TwoWay", "OneTime"]) {
    if (!modeAll.includes(want)) fail(`Mode= completion missing '${want}' (got ${modeAll.join(",")})`);
  }
  console.log(`[ok] completion(markup arg, 'Mode='): -> OneWay/TwoWay/OneTime (${modeAll.length} items)`);

  // 14e) partial Mode value filters to matching members and doesn't reopen the member list.
  const modePartial = await completeWith(26, `<Page ${NS}>\n  <TextBlock Text="{Binding Path=X, Mode=Tw|}" />\n</Page>`, "markup-arg-Mode-partial");
  if (!modePartial.includes("TwoWay")) fail(`Mode='Tw' should offer TwoWay (got ${modePartial.join(",")})`);
  if (modePartial.includes("OneWay")) fail(`Mode='Tw' should not offer OneWay (got ${modePartial.join(",")})`);
  console.log(`[ok] completion(markup arg, 'Mode=Tw'): -> TwoWay only (${modePartial.length} items)`);

  // 14f) {StaticResource key} completion pulls x:Key'd resources, including the project's App.xaml.
  const resAll = await completeWith(27, `<Page ${NS}>\n  <TextBlock Foreground="{StaticResource |}" />\n</Page>`, "resource-key");
  if (!resAll.includes("SmokeAccentBrush")) fail(`resource-key completion missing App.xaml 'SmokeAccentBrush' (got ${resAll.join(",")})`);
  console.log(`[ok] completion(resource, '{StaticResource '): -> SmokeAccentBrush from App.xaml (${resAll.length} items)`);

  // 14g) document-local x:Key resources are offered too, and a partial filters out non-matches.
  const resLocal = await completeWith(
    28,
    `<Page ${NS}>\n  <Page.Resources>\n    <SolidColorBrush x:Key="LocalBrush" />\n  </Page.Resources>\n  <TextBlock Foreground="{StaticResource Loc|}" />\n</Page>`,
    "resource-key-local"
  );
  if (!resLocal.includes("LocalBrush")) fail(`resource-key completion missing document-local 'LocalBrush' (got ${resLocal.join(",")})`);
  if (resLocal.includes("SmokeAccentBrush")) fail(`partial 'Loc' should filter out SmokeAccentBrush (got ${resLocal.join(",")})`);
  console.log(`[ok] completion(resource, '{StaticResource Loc'): -> LocalBrush, filtered (${resLocal.length} items)`);

  // 14h) common WinUI theme STYLE resources are offered on a Style-typed property (type-scoped, round 74).
  const resTheme = await completeWith(29, `<Page ${NS}>\n  <TextBlock Style="{StaticResource Tit|}" />\n</Page>`, "resource-key-theme");
  for (const needle of ["TitleTextBlockStyle", "TitleLargeTextBlockStyle"]) {
    if (!resTheme.includes(needle)) fail(`theme resource completion missing '${needle}' (got ${resTheme.join(",")})`);
  }
  if (resTheme.includes("SmokeAccentBrush")) fail(`partial 'Tit' should filter out SmokeAccentBrush (got ${resTheme.join(",")})`);
  console.log(`[ok] completion(resource, Style '{StaticResource Tit'): -> Title*TextBlockStyle theme resources (${resTheme.length} items)`);

  // 14i) ROUND 74: theme resource keys are type-scoped to the target property (VS parity). On a Brush
  // property the known incompatible Style/CornerRadius keys are hidden. Color's presentation-namespace
  // type is unresolved, so it remains available conservatively.
  const resBrushProp = await completeWith(493, `<Page ${NS}>\n  <TextBlock Foreground="{StaticResource |}" />\n</Page>`, "resource-key-typed-brush");
  if (!resBrushProp.includes("AccentFillColorDefaultBrush")) fail(`Brush property should offer theme brush key 'AccentFillColorDefaultBrush' (got ${resBrushProp.join(",")})`);
  if (!resBrushProp.includes("SmokeAccentBrush")) fail(`Brush property should still offer App.xaml author key 'SmokeAccentBrush' (got ${resBrushProp.join(",")})`);
  if (!resBrushProp.includes("ControlFillColorDefault")) fail(`Brush property should retain unknown-type color resources conservatively`);
  for (const hidden of ["AccentButtonStyle", "ControlCornerRadius"]) {
    if (resBrushProp.includes(hidden)) fail(`Brush property must HIDE non-brush theme key '${hidden}' (got ${resBrushProp.join(",")})`);
  }
  console.log(`[ok] completion(resource, Brush prop): brush + author keys, known incompatible types hidden (${resBrushProp.length} items)`);

  // 14j) On a Color property (SolidColorBrush.Color) theme COLOR keys are offered, brush/style hidden.
  const resColorProp = await completeWith(494, `<Page ${NS}>\n  <Page.Background>\n    <SolidColorBrush Color="{ThemeResource |}" />\n  </Page.Background>\n</Page>`, "resource-key-typed-color");
  if (!resColorProp.includes("ControlFillColorDefault")) fail(`Color property should offer theme color key 'ControlFillColorDefault' (got ${resColorProp.join(",")})`);
  for (const hidden of ["AccentFillColorDefaultBrush", "AccentButtonStyle"]) {
    if (resColorProp.includes(hidden)) fail(`Color property must HIDE non-color theme key '${hidden}' (got ${resColorProp.join(",")})`);
  }
  console.log(`[ok] completion(resource, Color prop): color keys offered, brush/style hidden (${resColorProp.length} items)`);

  // 14k) On a CornerRadius property (Border.CornerRadius) theme CORNER RADIUS keys are offered.
  const resCornerProp = await completeWith(495, `<Page ${NS}>\n  <Border CornerRadius="{StaticResource |}" />\n</Page>`, "resource-key-typed-corner");
  if (!resCornerProp.includes("ControlCornerRadius")) fail(`CornerRadius property should offer 'ControlCornerRadius' (got ${resCornerProp.join(",")})`);
  if (resCornerProp.includes("AccentFillColorDefaultBrush")) fail(`CornerRadius property must HIDE brush key (got ${resCornerProp.join(",")})`);
  console.log(`[ok] completion(resource, CornerRadius prop): corner-radius keys offered, brush hidden (${resCornerProp.length} items)`);

  // 14l) On an 'object' property (Tag) NO type filter is applied — every theme key is offered.
  const resTagProp = await completeWith(496, `<Page ${NS}>\n  <TextBlock Tag="{StaticResource |}" />\n</Page>`, "resource-key-object");
  for (const needle of ["AccentFillColorDefaultBrush", "AccentButtonStyle", "ControlFillColorDefault", "ControlCornerRadius"]) {
    if (!resTagProp.includes(needle)) fail(`object (Tag) property must offer ALL theme keys incl '${needle}' (got ${resTagProp.length} items)`);
  }
  console.log(`[ok] completion(resource, object Tag prop): all theme keys offered, no type filter (${resTagProp.length} items)`);

  // 14m) A resource nested in another markup extension is NOT type-scoped (it feeds the extension arg,
  // not the attribute), so every theme key is offered even on a Brush-typed attribute.
  const resNested = await completeWith(497, `<Page ${NS}>\n  <TextBlock Foreground="{Binding Source={StaticResource |}}" />\n</Page>`, "resource-key-nested");
  for (const needle of ["AccentFillColorDefaultBrush", "AccentButtonStyle", "ControlFillColorDefault"]) {
    if (!resNested.includes(needle)) fail(`nested resource must offer ALL theme keys incl '${needle}' (got ${resNested.join(",")})`);
  }
  console.log(`[ok] completion(resource, nested {Binding Source={StaticResource): all theme keys offered (${resNested.length} items)`);

  // 14n) ROUND 75: a <Setter Value="{StaticResource |}"> is declared 'object' but VS scopes it to the
  // property named by the sibling Property= on the enclosing TargetType (like the scalar Setter.Value
  // path). So a Setter for a Brush property scopes theme keys to brushes; author keys stay always-offered.
  const svBrush = await completeWith(498, pageRes(`<Style TargetType="TextBlock">\n      <Setter Property="Foreground" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-brush");
  if (!svBrush.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value(Foreground) should offer theme brush key (got ${svBrush.join(",")})`);
  if (!svBrush.includes("SmokeAccentBrush")) fail(`Setter.Value(Foreground) should still offer App.xaml author key 'SmokeAccentBrush' (got ${svBrush.join(",")})`);
  for (const hidden of ["AccentButtonStyle", "ControlCornerRadius"]) {
    if (svBrush.includes(hidden)) fail(`Setter.Value(Foreground) must HIDE non-brush theme key '${hidden}' (got ${svBrush.join(",")})`);
  }
  console.log(`[ok] completion(Setter.Value Foreground): brush + author keys, Style/Color/CornerRadius hidden (${svBrush.length} items)`);

  // 14o) A Setter for a CornerRadius property scopes theme keys to corner radii.
  const svCorner = await completeWith(499, pageRes(`<Style TargetType="Border">\n      <Setter Property="CornerRadius" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-corner");
  if (!svCorner.includes("ControlCornerRadius")) fail(`Setter.Value(CornerRadius) should offer 'ControlCornerRadius' (got ${svCorner.join(",")})`);
  if (svCorner.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value(CornerRadius) must HIDE brush key (got ${svCorner.join(",")})`);
  console.log(`[ok] completion(Setter.Value CornerRadius): corner-radius keys offered, brush hidden (${svCorner.length} items)`);

  // 14p) A Setter with NO resolvable Property= (ResolveSetterValueType -> null) offers EVERY theme key,
  // exactly as before round 75 (keeps the round-74 offer-all guarantee for untyped Setter.Value).
  const svNoProp = await completeWith(500, pageRes(`<Style TargetType="Button">\n      <Setter Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-noprop");
  for (const needle of ["AccentFillColorDefaultBrush", "AccentButtonStyle", "ControlFillColorDefault", "ControlCornerRadius"]) {
    if (!svNoProp.includes(needle)) fail(`Setter.Value with no Property must offer ALL theme keys incl '${needle}' (got ${svNoProp.length} items)`);
  }
  console.log(`[ok] completion(Setter.Value no Property): all theme keys offered (${svNoProp.length} items)`);

  // 14q) A Setter for Grid.Row scopes to int. Known incompatible framework types are hidden, while
  // unresolved framework types and project resources remain available conservatively.
  const svAttached = await completeWith(501, pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.Row" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-attached");
  if (!svAttached.includes("SmokeAccentBrush")) fail(`Setter.Value(Grid.Row) should still offer App.xaml author key 'SmokeAccentBrush' (got ${svAttached.join(",")})`);
  if (!svAttached.includes("ControlFillColorDefault")) fail(`Setter.Value(Grid.Row) should retain unknown-type color resources`);
  for (const hidden of ["AccentFillColorDefaultBrush", "AccentButtonStyle", "ControlCornerRadius"]) {
    if (svAttached.includes(hidden)) fail(`Setter.Value(Grid.Row : int) must HIDE theme key '${hidden}' (got ${svAttached.join(",")})`);
  }
  console.log(`[ok] completion(Setter.Value Grid.Row : int): known incompatible theme keys hidden (${svAttached.length} items)`);

  // 14r) ROUND 75 (x:Type TargetType): a Style whose TargetType uses the {x:Type Button} markup-extension
  // wrapper must scope Setter.Value identically to a bare TargetType="TextBlock" (ResolveStyleTargetType
  // unwraps the wrapper). Foreground -> brush + author keys, theme Style key hidden.
  const svXType = await completeWith(502, pageRes(`<Style TargetType="{x:Type TextBlock}">\n      <Setter Property="Foreground" Value="{StaticResource |}" />\n    </Style>`), "setterval-resource-xtype");
  if (!svXType.includes("AccentFillColorDefaultBrush")) fail(`Setter.Value under {x:Type TextBlock} should offer theme brush key (got ${svXType.join(",")})`);
  if (!svXType.includes("SmokeAccentBrush")) fail(`Setter.Value under {x:Type TextBlock} should offer author key (got ${svXType.join(",")})`);
  if (svXType.includes("TitleTextBlockStyle")) fail(`Setter.Value under {x:Type TextBlock} must HIDE theme Style key on a Brush property (got ${svXType.join(",")})`);
  console.log(`[ok] completion(Setter.Value {x:Type TextBlock}): brush + author keys, Style hidden (${svXType.length} items)`);

  // 15) hover on an element name -> the resolved type (works for framework metadata types).
  const typeHover = await hoverAt(30, `<Page ${NS}>\n  <But|ton />\n</Page>`, "element-name");
  if (!typeHover.includes("Button")) fail(`element-name hover missing 'Button': ${typeHover}`);
  if (!typeHover.includes("class")) fail(`element-name hover should name the type kind: ${typeHover}`);
  console.log(`[ok] hover(element): '<Button>' -> ${typeHover.replace(/\n/g, " ").trim()}`);

  // 16) hover on a simple attribute name -> the property/event symbol on the element type.
  const attrHover = await hoverAt(31, `<Page ${NS}>\n  <Button Con|tent="x" />\n</Page>`, "attribute-name");
  if (!attrHover.includes("Content")) fail(`attribute-name hover missing 'Content': ${attrHover}`);
  console.log(`[ok] hover(attribute): 'Button.Content' -> ${attrHover.replace(/\n/g, " ").trim()}`);

  // 16b) hover on a no-prefix <Owner.Member> property-element name -> the Member property on the owner type
  // (works for framework metadata like Grid.RowDefinitions; renders the property signature).
  const peHover = await hoverAt(32,
    `<Page ${NS}>\n  <Grid>\n    <Grid.RowDef|initions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-name");
  if (!peHover.includes("RowDefinitions")) fail(`property-element hover missing 'RowDefinitions': ${peHover}`);
  console.log(`[ok] hover(property element): '<Grid.RowDefinitions>' -> ${peHover.replace(/\n/g, " ").trim()}`);

  // 16c) a mis-cased / unknown property-element member resolves to no symbol -> no hover (conservative,
  // never guesses), mirroring the WXAML0006 case-sensitivity.
  const peHoverBad = await hoverAt(33,
    `<Page ${NS}>\n  <Grid>\n    <Grid.rowDef|initions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-name-bad");
  if (peHoverBad.includes("rowDefinitions") || peHoverBad.includes("RowDefinitions")) fail(`mis-cased property element should not hover to a member: ${peHoverBad}`);
  console.log(`[ok] hover(property element): mis-cased '<Grid.rowDefinitions>' -> no member hover (conservative)`);

  // 16d) caret on the OWNER segment of a property element resolves the owner TYPE, not the member — the
  // member must not masquerade under a caret that is not on it.
  const peHoverOwner = await hoverAt(34,
    `<Page ${NS}>\n  <Grid>\n    <Gr|id.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n  </Grid>\n</Page>`,
    "property-element-owner");
  if (peHoverOwner.includes("Grid.RowDefinitions")) fail(`owner-segment hover must not resolve the member: ${peHoverOwner}`);
  if (!peHoverOwner.includes("Grid")) fail(`owner-segment hover should resolve the Grid type: ${peHoverOwner}`);
  console.log(`[ok] hover(property element): owner segment '<Grid|.RowDefinitions>' -> ${peHoverOwner.replace(/\n/g, " ").trim()}`);

  // 17) document symbols (outline): the parsed element tree, annotated with x:Name.
  async function docSymbols(id, body, label) {
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: nextVersion() }, contentChanges: [{ text: body }] },
    });
    send({ id, method: "textDocument/documentSymbol", params: { textDocument: { uri: xamlUri } } });
    const res = await waitFor(responseFor(id), 30000, `documentSymbol ${label}`);
    if (res.error) fail(`documentSymbol ${label} errored: ${JSON.stringify(res.error)}`);
    return Array.isArray(res.result) ? res.result : [];
  }
  function flattenSymbols(nodes, out = []) {
    for (const n of nodes) {
      out.push(n);
      if (Array.isArray(n.children)) flattenSymbols(n.children, out);
    }
    return out;
  }

  const outline = await docSymbols(
    40,
    `<Page ${NS}>\n  <Grid>\n    <Button x:Name="GoButton" Content="Go" />\n  </Grid>\n</Page>`,
    "outline"
  );
  if (outline.length !== 1) fail(`outline should have a single root, got ${outline.length}`);
  if (!outline[0].name.includes("Page")) fail(`outline root should be Page, got '${outline[0].name}'`);
  const flatSymbols = flattenSymbols(outline);
  if (!flatSymbols.some((s) => s.name.includes("Grid"))) fail(`outline missing Grid: ${flatSymbols.map((s) => s.name).join(", ")}`);
  const namedSymbol = flatSymbols.find((s) => s.name.includes("GoButton"));
  if (!namedSymbol) fail(`outline missing the x:Name-annotated Button: ${flatSymbols.map((s) => s.name).join(", ")}`);
  if (!namedSymbol.name.includes("Button")) fail(`named symbol should be a Button, got '${namedSymbol.name}'`);
  console.log(`[ok] documentSymbol: Page > Grid > Button (GoButton) (${flatSymbols.length} symbols)`);

  // 13-14) semantic validation (diagnostics). Diagnostics arrive as publishDiagnostics notifications;
  //        the server sends a fast syntactic publish, then a combined one once semantic analysis runs.
  async function validateDoc(text, predicate, label) {
    const done = waitFor(
      (m) =>
        m.method === "textDocument/publishDiagnostics" &&
        m.params.uri === xamlUri &&
        predicate(m.params.diagnostics),
      30000,
      label
    );
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: xamlUri, version: nextVersion() }, contentChanges: [{ text }] },
    });
    return (await done).params.diagnostics;
  }

  // Inject exactly one unknown element into the REAL fixture: if any of the many real controls
  // (Grid, ScrollViewer, ItemsRepeater, DataTemplate, RowDefinition, ...) or property elements were
  // wrongly flagged, this assertion fails — so it doubles as a whole-fixture false-positive guard.
  const dirtyType = xamlText.replace("<Button", "<Buton");
  if (dirtyType === xamlText) fail("could not inject an unknown element into the fixture");
  const typeDiags = await validateDoc(
    dirtyType,
    (d) => d.some((x) => x.code === "WXAML0002" && x.message.includes("Buton")),
    "unknown-type diagnostic"
  );
  const unknownType = typeDiags.filter((x) => x.code === "WXAML0002");
  if (unknownType.length !== 1) {
    fail(`expected exactly 1 unknown-type diagnostic on the fixture, got ${unknownType.length}: ${JSON.stringify(typeDiags.map((t) => t.message))}`);
  }
  if (unknownType[0].severity !== 2) fail(`unknown-type should be a warning (severity 2), got ${unknownType[0].severity}`);
  // The whole fixture (every real control + attribute) must produce no OTHER diagnostics.
  if (typeDiags.length !== 1) fail(`expected exactly 1 total diagnostic on the fixture, got ${typeDiags.length}: ${JSON.stringify(typeDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: fixture + <Buton> -> exactly 1 unknown-type warning, zero false positives`);

  // Attribute typo on a known element -> unknown-property warning. Injecting into the real fixture also
  // guards against false positives across every valid attribute (NavigationCacheMode, Foreground, ...).
  const dirtyAttr = xamlText.replace('Text="Smoke Fixture"', 'Texx="Smoke Fixture"');
  if (dirtyAttr === xamlText) fail("could not inject an unknown attribute into the fixture");
  const attrDiags = await validateDoc(
    dirtyAttr,
    (d) => d.some((x) => x.code === "WXAML0003" && x.message.includes("Texx")),
    "unknown-attribute diagnostic"
  );
  const unknownAttr = attrDiags.filter((x) => x.code === "WXAML0003");
  if (unknownAttr.length !== 1) fail(`expected exactly 1 unknown-attribute diagnostic, got ${unknownAttr.length}: ${JSON.stringify(attrDiags.map((t) => `${t.code}:${t.message}`))}`);
  if (unknownAttr[0].severity !== 2) fail(`unknown-attribute should be a warning (severity 2), got ${unknownAttr[0].severity}`);
  if (attrDiags.length !== 1) fail(`expected exactly 1 total diagnostic, got ${attrDiags.length}: ${JSON.stringify(attrDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: TextBlock Texx="..." -> exactly 1 unknown-attribute warning, zero false positives`);

  // Attached-property typo (Owner.Member) -> WXAML0004. Injecting one bad member into the real fixture
  // also guards every valid attached property (the remaining Grid.Row's + AutomationProperties.AutomationId).
  const dirtyAttached = xamlText.replace("Grid.Row=", "Grid.Roww=");
  if (dirtyAttached === xamlText) fail("could not inject a bad attached property into the fixture");
  const attachedDiags = await validateDoc(
    dirtyAttached,
    (d) => d.some((x) => x.code === "WXAML0004" && x.message.includes("Roww")),
    "unknown-attached-property diagnostic"
  );
  const unknownAttached = attachedDiags.filter((x) => x.code === "WXAML0004");
  if (unknownAttached.length !== 1) fail(`expected exactly 1 attached-property diagnostic, got ${unknownAttached.length}: ${JSON.stringify(attachedDiags.map((t) => `${t.code}:${t.message}`))}`);
  if (unknownAttached[0].severity !== 2) fail(`attached-property should be a warning (severity 2), got ${unknownAttached[0].severity}`);
  if (attachedDiags.length !== 1) fail(`expected exactly 1 total diagnostic, got ${attachedDiags.length}: ${JSON.stringify(attachedDiags.map((t) => `${t.code}:${t.message}`))}`);
  console.log(`[ok] validation: Grid.Roww="..." -> exactly 1 attached-property warning, zero false positives`);

  // Undeclared namespace prefix -> error.
  const prefixDiags = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <zzz:Widget x:Name="w" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("zzz")),
    "undeclared-prefix diagnostic"
  );
  const undeclared = prefixDiags.filter((x) => x.code === "WXAML0001");
  if (undeclared.length !== 1) fail(`expected exactly 1 undeclared-prefix diagnostic, got ${undeclared.length}: ${JSON.stringify(prefixDiags)}`);
  if (undeclared[0].severity !== 1) fail(`undeclared-prefix should be an error (severity 1), got ${undeclared[0].severity}`);
  console.log(`[ok] validation: '<zzz:Widget>' -> undeclared-prefix error`);

  const invalidDouble = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Button Width="abc" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0012" && x.message.includes("Width")),
    "invalid-double diagnostic"
  );
  const invalidDoubleHits = invalidDouble.filter((x) => x.code === "WXAML0012");
  if (invalidDoubleHits.length !== 1 || invalidDoubleHits[0].severity !== 1) {
    fail(`Width="abc" should produce exactly one WXAML0012 error: ${JSON.stringify(invalidDouble)}`);
  }

  const validSingleQuote = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Button Width='12.5' />\n</Page>`,
    (d) => d.length === 0,
    "single-quoted numeric value"
  );
  if (validSingleQuote.length !== 0) {
    fail(`single-quoted XAML attributes are legal and must remain diagnostic-free: ${JSON.stringify(validSingleQuote)}`);
  }
  console.log(`[ok] validation(values): Width="abc" -> WXAML0012; Width='12.5' remains valid XML/XAML`);

  const invalidWinUiValues = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">
  <Border CornerRadius="8,bad,8,0" BorderThickness="1,2,nope,4" BorderBrush="DefinitelyNotABrush" />
</Page>`,
    (d) => d.filter((x) => x.code === "WXAML0012").length === 3,
    "invalid WinUI converter values"
  );
  const invalidWinUiValueHits = invalidWinUiValues.filter((x) => x.code === "WXAML0012");
  if (invalidWinUiValueHits.length !== 3 || invalidWinUiValueHits.some((x) => x.severity !== 1)) {
    fail(`invalid CornerRadius, Thickness, and Brush values should produce three WXAML0012 errors: ${JSON.stringify(invalidWinUiValues)}`);
  }

  const validWinUiValues = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">
  <Border CornerRadius="8 0 8 0" BorderThickness="1,2" BorderBrush="#80112233" Background="Red" />
</Page>`,
    (d) => d.length === 0,
    "valid WinUI converter values"
  );
  if (validWinUiValues.length !== 0) {
    fail(`valid CornerRadius, Thickness, and Brush values must remain diagnostic-free: ${JSON.stringify(validWinUiValues)}`);
  }

  const emptyWinUiValues = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">
  <Border CornerRadius="" BorderThickness="" BorderBrush=""><TextBlock Text="" /></Border>
</Page>`,
    (d) => d.filter((x) => x.code === "WXAML0012").length === 3,
    "empty WinUI converter values"
  );
  const emptyWinUiValueHits = emptyWinUiValues.filter((x) => x.code === "WXAML0012");
  if (emptyWinUiValueHits.length !== 3) {
    fail(`empty CornerRadius, Thickness, and Brush values should be invalid while Text="" remains valid: ${JSON.stringify(emptyWinUiValues)}`);
  }
  console.log(`[ok] validation(WinUI values): converter-backed structs, brushes, colors, and known non-string empty literals`);

  const misspelledThemeResource = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">
  <TextBlock Foreground="{ThemeResource TextFillColorSecondaryBru}" />
</Page>`,
    (d) => d.some((x) => x.code === "WXAML0013" && x.message.includes("TextFillColorSecondaryBru")),
    "misspelled theme-resource key"
  );
  const misspelledThemeResourceHits = misspelledThemeResource.filter((x) => x.code === "WXAML0013");
  if (misspelledThemeResourceHits.length !== 1 || misspelledThemeResourceHits[0].severity !== 1) {
    fail(`misspelled ThemeResource key should produce one WXAML0013 error: ${JSON.stringify(misspelledThemeResource)}`);
  }

  const validThemeResource = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">
  <TextBlock Foreground="{ThemeResource TextFillColorSecondaryBrush}" />
</Page>`,
    (d) => d.length === 0,
    "valid theme-resource key"
  );
  if (validThemeResource.length !== 0) {
    fail(`known ThemeResource key must remain diagnostic-free: ${JSON.stringify(validThemeResource)}`);
  }
  console.log(`[ok] validation(resource keys): misspelled SDK ThemeResource -> WXAML0013; exact key remains valid`);

  // 19) Round-7 regressions: function-binding F12, x:Bind completion noise, invalid-member diagnostic, unquoted value.
  const fnF12 = await definitionWith(210, pageCls('<Button Click="{x:Bind OnGo_Cl|ick()}" />'), "fn-binding-f12");
  if (!fnF12?.uri || !fnF12.uri.endsWith("SmokePage.xaml.cs")) {
    fail(`function-style x:Bind F12 (OnGo_Click()) did not resolve to SmokePage.xaml.cs (got ${fnF12?.uri ?? "null"})`);
  }
  console.log(`[ok] definition(x:Bind function binding): OnGo_Click() -> SmokePage.xaml.cs`);

  const bindNoise = await completeWith(211, pageCls('<TextBlock Text="{x:Bind |}" />'), "xbind-noise");
  if (!bindNoise.includes("GreetingText") || !bindNoise.includes("Items")) fail(`x:Bind root completion missing source members (got ${bindNoise.length})`);
  if (bindNoise.includes("InitializeComponent")) fail(`x:Bind completion leaked generated 'InitializeComponent'`);
  if (bindNoise.includes("FindName")) fail(`x:Bind completion flooded framework method 'FindName'`);
  console.log(`[ok] completion(x:Bind root): source members kept, generated/framework noise dropped (${bindNoise.length} items)`);

  const badBind = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind DefinitelyMissingMember}" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "invalid-x:Bind diagnostic");
  const badMember = badBind.filter((x) => x.code === "WXAML0005");
  if (badMember.length !== 1) fail(`expected exactly 1 WXAML0005, got ${badMember.length}: ${JSON.stringify(badBind.map((x) => `${x.code}:${x.message}`))}`);
  if (badMember[0].severity !== 2) fail(`invalid x:Bind member should be a warning (severity 2), got ${badMember[0].severity}`);
  if (badBind.length !== 1) fail(`expected exactly 1 total diagnostic for the invalid-x:Bind buffer, got ${badBind.length}`);
  console.log(`[ok] validation: '{x:Bind DefinitelyMissingMember}' -> exactly 1 WXAML0005 warning`);

  const uBool = await completeWith(212, pageCls("<Button IsEnabled=| />"), "unquoted-bool");
  if (!uBool.includes("True") || !uBool.includes("False")) fail(`unquoted 'IsEnabled=' should complete True/False (got ${uBool.join(", ")})`);
  console.log(`[ok] completion(unquoted value): 'IsEnabled=|' -> True/False (${uBool.length} items)`);

  // 20) Round-8 regressions: markup-extension-name hover, enum-value hover, nested DataTemplate x:DataType
  //     scoping (completion + validation), and x:Bind argument-name completion after nested/named args.
  const bindNameHover = await hoverAt(220, pageCls('<TextBlock Text="{x:B|ind GreetingText}" />'), "xbind-name-hover");
  if (!/x:Bind/i.test(bindNameHover) || !/compiled|bind/i.test(bindNameHover)) fail(`x:Bind name hover should describe the extension (got ${JSON.stringify(bindNameHover)})`);
  console.log(`[ok] hover(markup name): '{x:Bind}' -> ${bindNameHover.replace(/\n/g, " ").trim().slice(0, 60)}...`);

  const resNameHover = await hoverAt(221, pageCls('<Grid Background="{StaticR|esource SmokeAccentBrush}" />'), "staticresource-name-hover");
  if (!/StaticResource/i.test(resNameHover) || !/resource/i.test(resNameHover)) fail(`StaticResource name hover should describe resource lookup (got ${JSON.stringify(resNameHover)})`);
  console.log(`[ok] hover(markup name): '{StaticResource}' -> ${resNameHover.replace(/\n/g, " ").trim().slice(0, 60)}...`);

  const enumHover = await hoverAt(222, pageCls('<Button HorizontalAlignment="Cent|er" />'), "enum-value-hover");
  if (!/HorizontalAlignment/i.test(enumHover) || !/Center/.test(enumHover)) fail(`enum value hover should show HorizontalAlignment.Center (got ${JSON.stringify(enumHover)})`);
  console.log(`[ok] hover(enum value): 'HorizontalAlignment="Center"' -> ${enumHover.replace(/\n/g, " ").trim()}`);

  const modeHover = await hoverAt(223, pageCls('<TextBlock Text="{x:Bind GreetingText, Mode=One|Way}" />'), "bindmode-value-hover");
  if (!/OneWay/.test(modeHover) || !/BindingMode|Mode/i.test(modeHover)) fail(`x:Bind Mode value hover should show BindingMode.OneWay (got ${JSON.stringify(modeHover)})`);
  console.log(`[ok] hover(enum arg value): 'Mode=OneWay' -> ${modeHover.replace(/\n/g, " ").trim()}`);

  const innerScope = await completeWith(
    224,
    pageClsLocal('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><StackPanel><StackPanel.Resources><DataTemplate x:Key="T" x:DataType="x:String"><TextBlock Text="{x:Bind |}" /></DataTemplate></StackPanel.Resources></StackPanel></DataTemplate></ListView.ItemTemplate></ListView>'),
    "nested-datatemplate-scope");
  if (!innerScope.includes("Length")) fail(`inner x:String DataTemplate completion should include String.Length (got ${innerScope.slice(0, 40).join(", ")})`);
  if (innerScope.includes("GreetingText")) fail(`inner x:String DataTemplate completion must not leak outer SmokePage.GreetingText (got ${innerScope.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(nested DataTemplate): inner x:String -> Length, no outer GreetingText (${innerScope.length} items)`);

  const innerDiag = await validateDoc(
    pageClsLocal('<ListView><ListView.ItemTemplate><DataTemplate x:DataType="local:SmokePage"><StackPanel><DataTemplate x:DataType="x:String"><TextBlock Text="{x:Bind GreetingText}" /></DataTemplate></StackPanel></DataTemplate></ListView.ItemTemplate></ListView>'),
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingText")),
    "nested-datatemplate-diagnostic");
  const innerBad = innerDiag.filter((x) => x.code === "WXAML0005");
  if (innerBad.length !== 1) fail(`inner x:String template should flag GreetingText once, got ${innerBad.length}: ${JSON.stringify(innerDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(nested DataTemplate): inner x:String flags GreetingText (WXAML0005)`);

  const argNames = await completeWith(
    225,
    pageCls('<Page.Resources><SolidColorBrush x:Key="C" Color="Red" /></Page.Resources>\n  <TextBlock Text="{x:Bind GreetingText, Converter={StaticResource C}, ConverterParameter=abc, |}" />'),
    "xbind-argname");
  for (const want of ["Mode", "FallbackValue", "TargetNullValue"]) {
    if (!argNames.includes(want)) fail(`x:Bind arg-name completion after ConverterParameter should include '${want}' (got ${argNames.slice(0, 40).join(", ")})`);
  }
  console.log(`[ok] completion(x:Bind arg names): after Converter/ConverterParameter -> Mode/FallbackValue/TargetNullValue (${argNames.length} items)`);

  // 21) Round-9 regressions: attached-property completion inside <Setter Property="Owner.">, and
  //     hover on a non-first x:Bind path segment resolving against the preceding segment's type.
  const setterAttached = await completeWith(
    230,
    pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.|" Value="1" />\n    </Style>`),
    "setter-attached-property");
  if (!setterAttached.includes("Grid.Row") || !setterAttached.includes("Grid.Column")) fail(`Setter Property="Grid." should complete Grid.Row/Grid.Column (got ${setterAttached.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(Setter attached property): 'Grid.' -> Grid.Row/Grid.Column (${setterAttached.length} items)`);

  const secondSegHover = await hoverAt(231, pageCls('<TextBlock Text="{x:Bind GreetingText.Len|gth}" />'), "xbind-second-segment-hover");
  if (!/Length/.test(secondSegHover) || !/\bint\b|Int32/.test(secondSegHover)) fail(`x:Bind second-segment hover should resolve String.Length : int (got ${JSON.stringify(secondSegHover)})`);
  if (/GreetingText/.test(secondSegHover)) fail(`x:Bind second-segment hover should describe Length, not the first segment GreetingText (got ${JSON.stringify(secondSegHover)})`);
  console.log(`[ok] hover(x:Bind second segment): 'GreetingText.Length' -> ${secondSegHover.replace(/\n/g, " ").trim()}`);

  // 22) Round-10 regressions: named-element references (ElementName / Storyboard.TargetName) and
  //     attached-property hover (attribute name + Setter Property value).
  const enNamed =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBox x:Name="InputBox" />\n` +
    `    <TextBlock Text="{Binding ElementName=InputBox}" />\n  </StackPanel>\n</Page>`;
  const enLine = enNamed.split("\n").findIndex((l) => l.includes('x:Name="InputBox"'));

  // 22a) ElementName value completion offers the x:Name'd elements (no word-based fallback over stdio).
  const enComp = await completeWith(240, enNamed.replace("ElementName=InputBox", "ElementName=|"), "elementname-completion");
  if (!enComp.includes("InputBox")) fail(`ElementName completion should offer 'InputBox' (got ${enComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(ElementName): '{Binding ElementName=' -> InputBox (${enComp.length} items)`);

  // 22b) F12 on an ElementName value lands on the x:Name declaration in this document.
  const enDef = await definitionWith(241, enNamed.replace("ElementName=InputBox", "ElementName=Inp|utBox"), "elementname-f12");
  if (!enDef?.uri || !enDef.uri.toLowerCase().endsWith("smokepage.xaml")) fail(`ElementName F12 should land in this document (got ${enDef?.uri})`);
  if (enDef.range.start.line !== enLine) fail(`ElementName F12 should land on x:Name line ${enLine} (got ${enDef.range.start.line})`);
  console.log(`[ok] definition(ElementName): 'InputBox' -> ${enDef.uri} @ line ${enDef.range.start.line}`);

  // 22c) Hover on an ElementName value identifies the referenced element + its type.
  const enHover = await hoverAt(242, enNamed.replace("ElementName=InputBox", "ElementName=Inp|utBox"), "elementname-hover");
  if (!/InputBox/.test(enHover) || !/TextBox/.test(enHover)) fail(`ElementName hover should mention InputBox + TextBox (got ${JSON.stringify(enHover)})`);
  console.log(`[ok] hover(ElementName): 'InputBox' -> ${enHover.replace(/\n/g, " ").trim()}`);

  // 22d) F12 on Storyboard.TargetName lands on the x:Name declaration (not the generated backing field).
  const tnNamed =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Button x:Name="GoButton" />\n` +
    `    <Storyboard>\n      <ObjectAnimationUsingKeyFrames Storyboard.TargetName="GoButton" />\n` +
    `    </Storyboard>\n  </Grid>\n</Page>`;
  const tnLine = tnNamed.split("\n").findIndex((l) => l.includes('x:Name="GoButton"'));
  const tnDef = await definitionWith(243, tnNamed.replace('TargetName="GoButton"', 'TargetName="Go|Button"'), "targetname-f12");
  if (!tnDef?.uri || !tnDef.uri.toLowerCase().endsWith("smokepage.xaml")) fail(`Storyboard.TargetName F12 should land in this document (got ${tnDef?.uri})`);
  if (tnDef.range.start.line !== tnLine) fail(`Storyboard.TargetName F12 should land on x:Name line ${tnLine} (got ${tnDef.range.start.line})`);
  console.log(`[ok] definition(Storyboard.TargetName): 'GoButton' -> ${tnDef.uri} @ line ${tnDef.range.start.line}`);

  // 22e) Hover on an attached-property attribute name (Grid.Row="1") identifies the attached property.
  const grHover = await hoverAt(244, pageCls('<Grid>\n    <Button Grid.R|ow="1" />\n  </Grid>'), "attached-name-hover");
  if (!/Row/.test(grHover) || !/\bint\b|Int32/.test(grHover)) fail(`Grid.Row attribute-name hover should identify Row : int (got ${JSON.stringify(grHover)})`);
  console.log(`[ok] hover(attached name): 'Grid.Row' -> ${grHover.replace(/\n/g, " ").trim()}`);

  // 22f) Hover on a <Setter Property="Grid.Row"> value identifies the attached property.
  const spAttachedHover = await hoverAt(245, pageRes(`<Style TargetType="Button">\n      <Setter Property="Grid.R|ow" Value="1" />\n    </Style>`), "attached-setterprop-hover");
  if (!/Row/.test(spAttachedHover) || !/\bint\b|Int32/.test(spAttachedHover)) fail(`Setter Property="Grid.Row" hover should identify Row : int (got ${JSON.stringify(spAttachedHover)})`);
  console.log(`[ok] hover(Setter attached property): 'Grid.Row' -> ${spAttachedHover.replace(/\n/g, " ").trim()}`);

  // 22g) VisualState <Setter Target="Elem."> completes the named element's property members (VSM parity).
  const vsmSetter =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <VisualStateManager.VisualStateGroups>\n      <VisualStateGroup>\n        <VisualState>\n` +
    `          <VisualState.Setters>\n            <Setter Target="Chrome.OPH" Value="0.5" />\n` +
    `          </VisualState.Setters>\n        </VisualState>\n      </VisualStateGroup>\n` +
    `    </VisualStateManager.VisualStateGroups>\n  </Grid>\n</Page>`;
  const vsmProp = await completeWith(246, vsmSetter.replace("Chrome.OPH", "Chrome.|"), "vsm-setter-target-prop");
  if (!vsmProp.includes("Opacity") || !vsmProp.includes("Background")) fail(`Setter Target="Chrome." should complete Border props Opacity/Background (got ${vsmProp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(VSM Setter.Target prop): 'Chrome.' -> Opacity/Background (${vsmProp.length} items)`);

  // 22h) VisualState <Setter Target="|"> (element-name segment) completes x:Name'd elements in scope.
  const vsmElem = await completeWith(247, vsmSetter.replace('Target="Chrome.OPH"', 'Target="|"'), "vsm-setter-target-elem");
  if (!vsmElem.includes("Chrome")) fail(`Setter Target="" should complete element name 'Chrome' (got ${vsmElem.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(VSM Setter.Target elem): 'Target="' -> Chrome (${vsmElem.length} items)`);

  // 22i) Storyboard.TargetProperty="|" completes properties of the element named by the sibling TargetName.
  const sbAnim =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <Storyboard>\n      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="OPH" To="0.5" />\n` +
    `    </Storyboard>\n  </Grid>\n</Page>`;
  const sbProp = await completeWith(248, sbAnim.replace('TargetProperty="OPH"', 'TargetProperty="|"'), "storyboard-targetproperty");
  if (!sbProp.includes("Opacity")) fail(`Storyboard.TargetProperty="" should complete target Border prop 'Opacity' (got ${sbProp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(Storyboard.TargetProperty): -> Opacity (${sbProp.length} items)`);

  // 23) Round-11: x:Bind indexer paths (Items[0].Member) and function-binding arguments (Method(arg)).
  //     Proven hermetically over stdio so no VS Code word-based suggestions can confound the assertions.
  const idxComp = await completeWith(250, pageCls('<TextBlock Text="{x:Bind Items[0].|}" />'), "xbind-indexer-completion");
  if (!idxComp.includes("Length")) fail(`x:Bind indexer 'Items[0].' should complete String.Length (got ${idxComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind indexer): 'Items[0].' -> Length (${idxComp.length} items)`);

  const idxHover = await hoverAt(251, pageCls('<TextBlock Text="{x:Bind Items[0].Len|gth}" />'), "xbind-indexer-hover");
  if (!/Length/.test(idxHover) || !/\bint\b|Int32/.test(idxHover)) fail(`x:Bind indexer member hover should resolve String.Length : int (got ${JSON.stringify(idxHover)})`);
  if (/Items/.test(idxHover)) fail(`x:Bind indexer member hover should describe Length, not the Items collection (got ${JSON.stringify(idxHover)})`);
  console.log(`[ok] hover(x:Bind indexer member): 'Items[0].Length' -> ${idxHover.replace(/\n/g, " ").trim()}`);

  const idxBaseHover = await hoverAt(252, pageCls('<TextBlock Text="{x:Bind Item|s[0].Length}" />'), "xbind-indexer-base-hover");
  if (!/Items/.test(idxBaseHover)) fail(`x:Bind hover on the indexer base should identify the Items member (got ${JSON.stringify(idxBaseHover)})`);
  console.log(`[ok] hover(x:Bind indexer base): 'Items[0]' -> ${idxBaseHover.replace(/\n/g, " ").trim()}`);

  const argF12 = await definitionWith(253, pageCls('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />'), "xbind-arg-f12");
  if (!argF12?.uri || !argF12.uri.endsWith("SmokePage.xaml.cs")) fail(`x:Bind function-arg F12 (GreetingText) should resolve to SmokePage.xaml.cs (got ${argF12?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind function arg): OnGo_Click(GreetingText) -> SmokePage.xaml.cs`);

  const argHover = await hoverAt(254, pageCls('<TextBlock Text="{x:Bind OnGo_Click(Greeting|Text)}" />'), "xbind-arg-hover");
  if (!/GreetingText/.test(argHover) || !/string|String/.test(argHover)) fail(`x:Bind function-arg hover should identify GreetingText : string (got ${JSON.stringify(argHover)})`);
  console.log(`[ok] hover(x:Bind function arg): OnGo_Click(GreetingText) -> ${argHover.replace(/\n/g, " ").trim()}`);

  // A comma-separated function-binding argument list stays one positional path argument, so a later
  // argument still resolves (the parser tracks parenthesis depth when splitting markup arguments).
  const argF12b = await definitionWith(255, pageCls('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, Greeting|Text)}" />'), "xbind-arg2-f12");
  if (!argF12b?.uri || !argF12b.uri.endsWith("SmokePage.xaml.cs")) fail(`x:Bind later function-arg F12 should resolve to SmokePage.xaml.cs (got ${argF12b?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind later function arg): OnGo_Click(_, GreetingText) -> SmokePage.xaml.cs`);

  // 23b) Boolean negation ({x:Bind !Member}) still validates/completes/hovers the member after the '!'.
  const negComp = await completeWith(256, pageCls('<TextBlock Text="{x:Bind !Greet|}" />'), "xbind-negation-completion");
  if (!negComp.includes("GreetingText")) fail(`negated x:Bind '!Greet' should complete GreetingText (got ${negComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind negation): '!Greet' -> GreetingText (${negComp.length} items)`);

  const negHover = await hoverAt(257, pageCls('<TextBlock Text="{x:Bind !Greeting|Text}" />'), "xbind-negation-hover");
  if (!/GreetingText/.test(negHover) || !/string|String/.test(negHover)) fail(`negated x:Bind hover should identify GreetingText : string (got ${JSON.stringify(negHover)})`);
  console.log(`[ok] hover(x:Bind negation): '!GreetingText' -> ${negHover.replace(/\n/g, " ").trim()}`);

  const negDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind !DefinitelyMissingNegated}" />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "xbind-negation-diagnostic");
  const negBad = negDiag.filter((x) => x.code === "WXAML0005");
  if (negBad.length !== 1) fail(`negated unknown member should raise exactly 1 WXAML0005, got ${negBad.length}: ${JSON.stringify(negDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/DefinitelyMissingNegated/.test(negBad[0].message)) fail(`negation diagnostic should name the missing member (got ${JSON.stringify(negBad[0].message)})`);
  if (negDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the negated-member buffer, got ${negDiag.length}`);
  console.log(`[ok] validation(x:Bind negation): '!DefinitelyMissingNegated' -> exactly 1 WXAML0005`);

  // 26) Cast x:Bind path ((local:Type)Member): the member after the cast resolves against the cast
  // target type for F12/hover/completion. A cast to the page's own type navigates to source.
  const pageCast = (inner) => `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
  const castF12 = await definitionWith(310, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />'), "xbind-cast-f12");
  if (!castF12?.uri || !castF12.uri.endsWith("SmokePage.xaml.cs")) fail(`cast x:Bind member F12 should resolve to SmokePage.xaml.cs (got ${castF12?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Bind cast): (local:SmokePage)GreetingText -> SmokePage.xaml.cs`);

  const castHover = await hoverAt(311, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greeting|Text}" />'), "xbind-cast-hover");
  if (!/GreetingText/.test(castHover) || !/string|String/.test(castHover)) fail(`cast x:Bind hover should identify GreetingText : string (got ${JSON.stringify(castHover)})`);
  console.log(`[ok] hover(x:Bind cast): (local:SmokePage)GreetingText -> ${castHover.replace(/\n/g, " ").trim()}`);

  const castComp = await completeWith(312, pageCast('<TextBlock Text="{x:Bind (local:SmokePage)Greet|}" />'), "xbind-cast-completion");
  if (!castComp.includes("GreetingText")) fail(`cast x:Bind '(local:SmokePage)Greet' should complete GreetingText (got ${castComp.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind cast): (local:SmokePage)Greet -> GreetingText (${castComp.length} items)`);

  // The cast genuinely rebinds the root: casting to x:String offers String.Length, which is NOT a
  // member of the page root (a bare {x:Bind Len} would not offer it).
  const castRebind = await completeWith(313, pageCast('<TextBlock Text="{x:Bind (x:String)Len|}" />'), "xbind-cast-rebind");
  if (!castRebind.includes("Length")) fail(`cast to x:String should complete String.Length (got ${castRebind.slice(0, 40).join(", ")})`);
  const pageRootNoLength = await completeWith(314, pageCast('<TextBlock Text="{x:Bind Len|}" />'), "xbind-root-no-length");
  if (pageRootNoLength.includes("Length")) fail(`page root should NOT offer String.Length without a cast (got ${pageRootNoLength.slice(0, 40).join(", ")})`);
  console.log(`[ok] completion(x:Bind cast rebind): (x:String)Len -> Length, page root -> no Length`);

  // 26b) Cast x:Bind TYPO diagnostics (WXAML0005): the member chain after a cast is validated against the
  // cast TARGET type (VS's XAML compiler checks these too). A bad tail member after a valid cast fires.
  const castTailDiag = await validateDoc(
    pageCast('<TextBlock Text="{x:Bind (local:SmokePage)GreetingText.Nope}" />'),
    (d) => d.some((x) => x.code === "WXAML0005" && /Nope/.test(x.message)),
    "xbind-cast-tail-typo");
  const castTailBad = castTailDiag.filter((x) => x.code === "WXAML0005");
  if (castTailBad.length !== 1) fail(`cast tail typo '(local:SmokePage)GreetingText.Nope' should raise exactly 1 WXAML0005, got ${castTailBad.length}: ${JSON.stringify(castTailDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(castTailBad[0].message)) fail(`cast tail diagnostic should name the missing member Nope (got ${JSON.stringify(castTailBad[0].message)})`);

  // A bad FIRST member checked directly against the cast target type fires too.
  const castFirstDiag = await validateDoc(
    pageCast('<TextBlock Text="{x:Bind (local:SmokePage)BogusMember}" />'),
    (d) => d.some((x) => x.code === "WXAML0005" && /BogusMember/.test(x.message)),
    "xbind-cast-first-typo");
  const castFirstBad = castFirstDiag.filter((x) => x.code === "WXAML0005");
  if (castFirstBad.length !== 1) fail(`cast first-member typo '(local:SmokePage)BogusMember' should raise exactly 1 WXAML0005, got ${castFirstBad.length}: ${JSON.stringify(castFirstDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/BogusMember/.test(castFirstBad[0].message)) fail(`cast first-member diagnostic should name BogusMember (got ${JSON.stringify(castFirstBad[0].message)})`);
  console.log(`[ok] validation(x:Bind cast typo): (local:SmokePage)GreetingText.Nope + (local:SmokePage)BogusMember -> 2 WXAML0005`);

  // 26c) Cast false-positive guard: a valid cast member chain, a valid intrinsic cast, an unresolved cast
  // target, and an attached-property step must ALL stay silent — only the plain sentinel path fires. This
  // proves cast validation adds no spurious diagnostics on the conservative paths.
  const castSilentInner = [
    '<StackPanel>',
    '    <TextBlock Text="{x:Bind (local:SmokePage)GreetingText}" />',
    '    <TextBlock Text="{x:Bind (x:String)Length}" />',
    '    <TextBlock Text="{x:Bind (Grid.Row)}" />',
    '    <TextBlock Text="{x:Bind (local:Unknown)Whatever}" />',
    '    <TextBlock Text="{x:Bind CastSentinelMissing}" />',
    '  </StackPanel>',
  ].join('\n  ');
  const castSilentDiag = await validateDoc(
    pageCast(castSilentInner),
    (d) => d.some((x) => x.code === "WXAML0005" && /CastSentinelMissing/.test(x.message)),
    "xbind-cast-silent-guard");
  const castSilentBad = castSilentDiag.filter((x) => x.code === "WXAML0005");
  if (castSilentBad.length !== 1) fail(`valid/unresolved/attached casts must add no WXAML0005 — only the sentinel should fire, got ${castSilentBad.length}: ${JSON.stringify(castSilentDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Bind cast silent guard): valid + intrinsic + unresolved + attached casts -> 0 spurious WXAML0005 (only sentinel)`);

  // 27) Attached-property x:Bind path ((Grid.Row)): hover identifies the attached property on the owner.
  const attachedHover = await hoverAt(315, pageCast('<TextBlock Text="{x:Bind (Grid.R|ow)}" />'), "xbind-attached-hover");
  if (!/Grid\.Row/.test(attachedHover)) fail(`attached x:Bind path hover should identify Grid.Row (got ${JSON.stringify(attachedHover)})`);
  if (!/attached property/.test(attachedHover)) fail(`attached x:Bind path hover should label it an attached property (got ${JSON.stringify(attachedHover)})`);
  console.log(`[ok] hover(x:Bind attached): (Grid.Row) -> ${attachedHover.replace(/\n/g, " ").trim()}`);

  // Caret precision: the attached-property hover fires ONLY on the member (Row), never on the owner
  // type (Grid) or the dot boundary -- otherwise hovering the owner wrongly claims it is the property.
  const attachedOnOwner = await hoverAt(316, pageCast('<TextBlock Text="{x:Bind (G|rid.Row)}" />'), "xbind-attached-owner-caret");
  if (/attached property/.test(attachedOnOwner)) fail(`caret on the owner type of (Grid.Row) must NOT render the attached-property hover (got ${JSON.stringify(attachedOnOwner)})`);
  const attachedOnDot = await hoverAt(317, pageCast('<TextBlock Text="{x:Bind (Grid|.Row)}" />'), "xbind-attached-dot-caret");
  if (/attached property/.test(attachedOnDot)) fail(`caret on the dot boundary of (Grid.Row) must NOT render the attached-property hover (got ${JSON.stringify(attachedOnDot)})`);
  console.log(`[ok] hover(x:Bind attached precision): caret on owner/dot -> no attached-property hover`);

  // 28) Round-28 regressions: function-argument validation/completion + lexically-scoped resource F12.
  // Function-binding arguments are paths bound against the root: a bogus argument member is flagged the
  // same as a bogus root path, while valid arguments (including indexer tails) stay silent.
  const fnArgDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind OnGo_Click(GreetingText, Items[0])}" />\n` +      // valid: both args are members
    `    <TextBlock Text="{x:Bind OnGo_Click(GreetingText, DefinitelyMissingArg28)}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "function-arg-diagnostic");
  const fnArgBad = fnArgDiag.filter((x) => x.code === "WXAML0005");
  if (fnArgBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bogus function argument (valid args must stay silent), got ${fnArgBad.length}: ${JSON.stringify(fnArgDiag.map((x) => x.code + ":" + x.message))}`);
  if (!/DefinitelyMissingArg28/.test(fnArgBad[0].message)) fail(`function-arg diagnostic should name the bogus argument (got ${JSON.stringify(fnArgBad[0].message)})`);
  console.log(`[ok] validation(x:Bind function arg): bogus arg -> 1 WXAML0005; valid args silent`);

  // Completion inside a function-argument gap offers page members (the next argument binds to the root).
  const fnArgComp = await completeWith(320, pageCls('<TextBlock Text="{x:Bind OnGo_Click(GreetingText, |)}" />'), "function-arg-completion");
  for (const want of ["GreetingText", "Items"]) {
    if (!fnArgComp.includes(want)) fail(`function-argument gap should complete '${want}' (got ${fnArgComp.slice(0, 40).join(", ")})`);
  }
  console.log(`[ok] completion(x:Bind function arg gap): OnGo_Click(GreetingText, |) -> page members (${fnArgComp.length} items)`);

  // A {StaticResource} reference inside a <Grid.Resources> scope resolves the NEAREST key, shadowing an
  // outer <Page.Resources> key of the same name; F12 selects the x:Key value span, not the element tag.
  const shadowBody =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n    <SolidColorBrush x:Key="ScopeKey28" Color="Red" />\n  </Page.Resources>\n` +
    `  <Grid>\n    <Grid.Resources>\n      <SolidColorBrush x:Key="ScopeKey28" Color="Blue" />\n    </Grid.Resources>\n` +
    `    <Border Background="{StaticResource Scope|Key28}" />\n  </Grid>\n</Page>`;
  const shadowClean = shadowBody.replaceAll("|", "");
  const shadowLines = shadowClean.split("\n");
  const expectedShadowLine = shadowLines.findIndex((l) => l.includes('x:Key="ScopeKey28"') && l.includes('Color="Blue"'));
  const shadowDef = await definitionWith(321, shadowBody, "scoped-resource-f12");
  if (!shadowDef?.range) fail(`scoped resource F12 should resolve; got ${JSON.stringify(shadowDef)}`);
  if (shadowDef.range.start.line !== expectedShadowLine) fail(`scoped resource F12 should land on the inner Grid.Resources key (line ${expectedShadowLine}), got line ${shadowDef.range.start.line}`);
  const shadowKeyText = shadowLines[shadowDef.range.start.line].slice(shadowDef.range.start.character, shadowDef.range.end.character);
  if (shadowKeyText !== "ScopeKey28") fail(`scoped resource F12 range should select the x:Key value 'ScopeKey28', got ${JSON.stringify(shadowKeyText)}`);
  console.log(`[ok] definition(scoped resource): inner Grid.Resources shadows Page.Resources; range selects x:Key value`);

  // 23a) The indexer first-segment base is validated: a bogus base is flagged while a valid Items[0] stays silent.
  const idxDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind Items[0].Length}" />\n` +
    `    <TextBlock Text="{x:Bind Bogus[0].Length}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "indexer-base-diagnostic");
  const idxBad = idxDiag.filter((x) => x.code === "WXAML0005");
  if (idxBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bogus indexer base, got ${idxBad.length}: ${JSON.stringify(idxDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Bogus/.test(idxBad[0].message)) fail(`indexer-base diagnostic should name the bogus base 'Bogus' (got ${JSON.stringify(idxBad[0].message)})`);
  if (idxDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the indexer buffer (Items[0] must stay silent), got ${idxDiag.length}`);
  console.log(`[ok] validation(x:Bind indexer base): 'Bogus[0]' -> 1 WXAML0005, 'Items[0]' silent`);

  // 23c) Property-element member validation (WXAML0006): a mis-cased property element (<Grid.rowDefinitions>)
  // is flagged, while a correctly-cased instance property element (<Grid.RowDefinitions>) and an attached
  // property used in element form (<Grid.Row>) stay silent — proving no false positives on valid forms.
  const peDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n` +
    `    <Grid.rowDefinitions>\n      <RowDefinition />\n    </Grid.rowDefinitions>\n` +
    `    <TextBlock><Grid.Row>0</Grid.Row></TextBlock>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0006"),
    "property-element-diagnostic");
  const peBad = peDiag.filter((x) => x.code === "WXAML0006");
  if (peBad.length !== 1) fail(`expected exactly 1 WXAML0006 for the mis-cased property element, got ${peBad.length}: ${JSON.stringify(peDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/rowDefinitions/.test(peBad[0].message)) fail(`property-element diagnostic should name the mis-cased member 'rowDefinitions' (got ${JSON.stringify(peBad[0].message)})`);
  if (peDiag.length !== 1) fail(`expected exactly 1 total diagnostic (valid <Grid.RowDefinitions> and attached <Grid.Row> must stay silent), got ${peDiag.length}: ${JSON.stringify(peDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(property element): '<Grid.rowDefinitions>' -> 1 WXAML0006; valid instance/attached forms silent`);

  // 23c2) UNKNOWN-OWNER property element (<Bogus.Foo>): the owner type does not resolve in the (known) default namespace, so it is flagged as an unknown type (WXAML0002) on the OWNER segment — mirroring a plain <Bogus> element. The member 'Foo' is NOT separately flagged, and a real property element in the same buffer (<Grid.RowDefinitions>) stays silent, proving the owner check doesn't over-fire.
  const poDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n` +
    `    <Grid.RowDefinitions>\n      <RowDefinition />\n    </Grid.RowDefinitions>\n` +
    `    <Bogus.Foo>\n      <RowDefinition />\n    </Bogus.Foo>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0002"),
    "property-element-unknown-owner");
  const poBad = poDiag.filter((x) => x.code === "WXAML0002");
  if (poBad.length !== 1) fail(`expected exactly 1 WXAML0002 for the unknown property-element owner, got ${poBad.length}: ${JSON.stringify(poDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Bogus/.test(poBad[0].message)) fail(`unknown-owner diagnostic should name the owner 'Bogus' (got ${JSON.stringify(poBad[0].message)})`);
  if (/Foo/.test(poBad[0].message)) fail(`unknown-owner diagnostic should flag the OWNER, not the member 'Foo' (got ${JSON.stringify(poBad[0].message)})`);
  if (poDiag.length !== 1) fail(`expected exactly 1 total diagnostic (valid <Grid.RowDefinitions> must stay silent), got ${poDiag.length}: ${JSON.stringify(poDiag.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(property element): '<Bogus.Foo>' -> 1 WXAML0002 on owner; valid forms silent`);

  // 23d) An event used as a property element (<Button.Click>) is WXAML0006 — events need attribute syntax,
  // so property-element syntax is invalid even though Click IS a member of Button.
  const evtDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Button>\n    <Button.Click>OnGo_Click</Button.Click>\n  </Button>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0006"),
    "event-property-element-diagnostic");
  const evtBad = evtDiag.filter((x) => x.code === "WXAML0006");
  if (evtBad.length !== 1) fail(`event-as-property-element should raise exactly 1 WXAML0006, got ${evtBad.length}: ${JSON.stringify(evtDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Click/.test(evtBad[0].message) || !/event/.test(evtBad[0].message)) fail(`event property-element diagnostic should name 'Click' and mention it is an event (got ${JSON.stringify(evtBad[0].message)})`);
  if (evtDiag.length !== 1) fail(`expected exactly 1 total diagnostic for the event-property-element buffer, got ${evtDiag.length}`);
  console.log(`[ok] validation(property element): '<Button.Click>' event -> 1 WXAML0006 (event-specific message)`);

  // 23e) x:Bind NON-FIRST-segment validation (WXAML0005 extended): a bad member after a valid first
  // segment is now flagged, while valid multi-segment paths (dotted, indexer-tail, interface members)
  // stay silent — the walk types each hop the same way completion/hover do.
  const nfDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind GreetingText.Length}" />\n` +      // valid: string.Length
    `    <TextBlock Text="{x:Bind Items[0].Length}" />\n` +          // valid: element (string).Length
    `    <TextBlock Text="{x:Bind Items.Count}" />\n` +              // valid: IReadOnlyList<>.Count (interface)
    `    <TextBlock Text="{x:Bind GreetingText.Nope}" />\n  </StackPanel>\n</Page>`, // INVALID: string has no Nope
    (d) => d.some((x) => x.code === "WXAML0005"),
    "nonfirst-segment-diagnostic");
  const nfBad = nfDiag.filter((x) => x.code === "WXAML0005");
  if (nfBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bad non-first member (valid dotted/indexer/interface paths must stay silent), got ${nfBad.length}: ${JSON.stringify(nfDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(nfBad[0].message)) fail(`non-first-segment diagnostic should name the bad member 'Nope' (got ${JSON.stringify(nfBad[0].message)})`);
  if (!/String/.test(nfBad[0].message)) fail(`non-first-segment diagnostic should name the owning type 'String' (got ${JSON.stringify(nfBad[0].message)})`);
  console.log(`[ok] validation(x:Bind non-first): 'GreetingText.Nope' -> 1 WXAML0005 on String; valid dotted/indexer/interface paths silent`);

  // 23f) The non-first walk unwraps indexer element types too: Items[0] is a string, so a bad tail
  // member after the indexer is flagged against String.
  const nfIdxDiag = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock Text="{x:Bind Items[0].Nope}" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0005"),
    "nonfirst-indexer-tail-diagnostic");
  const nfIdxBad = nfIdxDiag.filter((x) => x.code === "WXAML0005");
  if (nfIdxBad.length !== 1) fail(`expected exactly 1 WXAML0005 for the bad member after an indexer, got ${nfIdxBad.length}: ${JSON.stringify(nfIdxDiag.map((x) => `${x.code}:${x.message}`))}`);
  if (!/Nope/.test(nfIdxBad[0].message)) fail(`indexer-tail diagnostic should name the bad member 'Nope' (got ${JSON.stringify(nfIdxBad[0].message)})`);
  console.log(`[ok] validation(x:Bind non-first): 'Items[0].Nope' -> 1 WXAML0005 (indexer element type walked)`);

  // 24) {x:Type} / {x:Static} navigation + completion (round 20).
  const xTypeHover = await hoverAt(300,
    `<Page ${NS}>\n  <Button Tag="{x:Type Butt|on}" />\n</Page>`, "x:Type-hover");
  if (!/Button/.test(xTypeHover)) fail(`{x:Type Button} hover should identify the Button type (got ${JSON.stringify(xTypeHover)})`);
  if (!/class/.test(xTypeHover)) fail(`{x:Type Button} hover should render the class keyword (got ${JSON.stringify(xTypeHover)})`);
  console.log(`[ok] hover(x:Type): '{x:Type Button}' -> ${xTypeHover.replace(/\n/g, " ").trim()}`);

  const dLocalX = 'xmlns:local="using:SmokeFixture"';
  const xTypeDef = await definitionWith(301,
    `<Page ${NS} ${dLocalX}>\n  <Button Tag="{x:Type local:Smoke|Page}" />\n</Page>`, "x:Type-f12");
  if (!xTypeDef?.uri || !xTypeDef.uri.endsWith("SmokePage.xaml.cs")) fail(`{x:Type local:SmokePage} F12 should land on SmokePage.xaml.cs (got ${xTypeDef?.uri ?? "null"})`);
  console.log(`[ok] definition(x:Type user type): '{x:Type local:SmokePage}' -> SmokePage.xaml.cs`);

  const xStaticHover = await hoverAt(302,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visibility.Collap|sed}" />\n</Page>`, "x:Static-hover");
  if (!/Collapsed/.test(xStaticHover)) fail(`{x:Static Visibility.Collapsed} hover should name the Collapsed member (got ${JSON.stringify(xStaticHover)})`);
  if (!/Visibility/.test(xStaticHover)) fail(`{x:Static Visibility.Collapsed} hover should name the Visibility type (got ${JSON.stringify(xStaticHover)})`);
  console.log(`[ok] hover(x:Static): '{x:Static Visibility.Collapsed}' -> ${xStaticHover.replace(/\n/g, " ").trim()}`);

  // Caret on the OWNER segment resolves the owner TYPE, not the member (caret precision, like round 19).
  const xStaticOwner = await hoverAt(303,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visi|bility.Collapsed}" />\n</Page>`, "x:Static-owner");
  if (!/Visibility/.test(xStaticOwner)) fail(`{x:Static} owner-segment hover should resolve the Visibility type (got ${JSON.stringify(xStaticOwner)})`);
  if (/Collapsed/.test(xStaticOwner)) fail(`{x:Static} owner-segment hover must not resolve the Collapsed member (got ${JSON.stringify(xStaticOwner)})`);
  console.log(`[ok] hover(x:Static owner): '{x:Static Visi|bility.Collapsed}' -> ${xStaticOwner.replace(/\n/g, " ").trim()}`);

  const xTypeComplete = await completeWith(304,
    `<Page ${NS}>\n  <Button Tag="{x:Type Butt|}" />\n</Page>`, "x:Type-completion");
  if (!xTypeComplete.includes("Button")) fail(`{x:Type Butt} completion should offer Button (got ${xTypeComplete.length} items)`);
  console.log(`[ok] completion(x:Type): '{x:Type Butt' -> Button (${xTypeComplete.length} items)`);

  const xStaticComplete = await completeWith(305,
    `<Page ${NS}>\n  <Button Tag="{x:Static Visibility.|}" />\n</Page>`, "x:Static-completion");
  for (const want of ["Collapsed", "Visible"]) {
    if (!xStaticComplete.includes(want)) fail(`{x:Static Visibility.} completion missing '${want}' (got ${xStaticComplete.join(",")})`);
  }
  console.log(`[ok] completion(x:Static members): '{x:Static Visibility.' -> Collapsed/Visible (${xStaticComplete.length} items)`);

  const xNameComplete = await completeWith(306,
    `<Page ${NS}>\n  <Button Tag="{x:S|}" />\n</Page>`, "x:Static-name-completion");
  if (!xNameComplete.includes("x:Static")) fail(`'{x:S' should offer the x:Static markup extension (got ${xNameComplete.join(",")})`);
  console.log(`[ok] completion(markup name): '{x:S' -> x:Static (${xNameComplete.length} items)`);

  // 24b) Type-reference completion ({x:Type} / {x:Static} owner) offers ALL type kinds — enums and structs and static classes — not just instantiable classes like element-name completion. Regression guard for the round-21 fix: Visibility (enum) and Thickness (struct) are reachable here even though they are excluded from <Element> completion.
  const xTypeEnum = await completeWith(307,
    `<Page ${NS}>\n  <Button Tag="{x:Type Vis|}" />\n</Page>`, "x:Type-enum-completion");
  if (!xTypeEnum.includes("Visibility")) fail(`{x:Type Vis} completion should offer the Visibility enum (got ${xTypeEnum.join(",")})`);
  console.log(`[ok] completion(x:Type enum): '{x:Type Vis' -> Visibility (${xTypeEnum.length} items)`);

  const xTypeStruct = await completeWith(308,
    `<Page ${NS}>\n  <Button Tag="{x:Type Thick|}" />\n</Page>`, "x:Type-struct-completion");
  if (!xTypeStruct.includes("Thickness")) fail(`{x:Type Thick} completion should offer the Thickness struct (got ${xTypeStruct.join(",")})`);
  console.log(`[ok] completion(x:Type struct): '{x:Type Thick' -> Thickness (${xTypeStruct.length} items)`);

  const xStaticOwnerEnum = await completeWith(309,
    `<Page ${NS}>\n  <Button Tag="{x:Static Vis|}" />\n</Page>`, "x:Static-owner-enum-completion");
  if (!xStaticOwnerEnum.includes("Visibility")) fail(`{x:Static Vis} owner completion should offer the Visibility enum (got ${xStaticOwnerEnum.join(",")})`);
  console.log(`[ok] completion(x:Static owner enum): '{x:Static Vis' -> Visibility (${xStaticOwnerEnum.length} items)`);

  // 25a) DUPLICATE x:Name in the same (page-root) name scope -> exactly 1 WXAML0007 (an error) on the
  // duplicated name; a differently-named sibling stays silent, proving the check does not over-fire.
  const dupName = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <Button x:Name="Dup" />\n` +
    `    <TextBlock x:Name="Unique" />\n` +
    `    <Button x:Name="Dup" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0007"),
    "duplicate-x-name");
  const dupNameBad = dupName.filter((x) => x.code === "WXAML0007");
  if (dupNameBad.length !== 1) fail(`expected exactly 1 WXAML0007 for the duplicated x:Name, got ${dupNameBad.length}: ${JSON.stringify(dupName.map((x) => `${x.code}:${x.message}`))}`);
  if (!/\bDup\b/.test(dupNameBad[0].message)) fail(`duplicate-name diagnostic should name 'Dup' (got ${JSON.stringify(dupNameBad[0].message)})`);
  if (dupNameBad[0].severity !== 1) fail(`duplicate x:Name should be an error (severity 1), got ${dupNameBad[0].severity}`);
  if (dupName.length !== 1) fail(`expected exactly 1 total diagnostic (the uniquely-named sibling must stay silent), got ${dupName.length}: ${JSON.stringify(dupName.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Name): duplicate 'Dup' -> 1 WXAML0007 (error); unique name silent`);

  // 25b) The SAME x:Name reused at page scope AND inside two separate DataTemplates is NOT a collision:
  // each template instantiates its own name scope. Proven with a genuine page-scope duplicate ('Trigger')
  // as the sentinel — exactly 1 WXAML0007 must fire, and it must name 'Trigger', never the scoped 'Item'.
  const scopedName = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel>\n` +
    `    <TextBlock x:Name="Item" />\n` +
    `    <ContentControl>\n      <DataTemplate>\n        <TextBlock x:Name="Item" />\n      </DataTemplate>\n    </ContentControl>\n` +
    `    <ContentControl>\n      <DataTemplate>\n        <TextBlock x:Name="Item" />\n      </DataTemplate>\n    </ContentControl>\n` +
    `    <Button x:Name="Trigger" />\n    <Button x:Name="Trigger" />\n  </StackPanel>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0007"),
    "scoped-x-name");
  const scopedBad = scopedName.filter((x) => x.code === "WXAML0007");
  if (scopedBad.length !== 1) fail(`per-scope names must not collide: expected exactly 1 WXAML0007 (the page-scope 'Trigger' dup), got ${scopedBad.length}: ${JSON.stringify(scopedName.map((x) => `${x.code}:${x.message}`))}`);
  if (!/\bTrigger\b/.test(scopedBad[0].message)) fail(`the only duplicate-name diagnostic should name 'Trigger' (got ${JSON.stringify(scopedBad[0].message)})`);
  if (/\bItem\b/.test(scopedBad[0].message)) fail(`x:Name 'Item' reused across separate template scopes must NOT be flagged (got ${JSON.stringify(scopedBad[0].message)})`);
  console.log(`[ok] validation(x:Name): 'Item' across two DataTemplates + page scope -> silent; only page-scope 'Trigger' dup fires`);

  // 25c) DUPLICATE x:Key in one dictionary (<Page.Resources>) -> exactly 1 WXAML0008 (an error); a
  // distinctly-keyed entry and the dictionary property element itself stay silent (no false positives).
  const dupKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Accent" Color="Red" />\n` +
    `    <SolidColorBrush x:Key="Other" Color="Green" />\n` +
    `    <SolidColorBrush x:Key="Accent" Color="Blue" />\n  </Page.Resources>\n` +
    `  <Grid />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "duplicate-x-key");
  const dupKeyBad = dupKey.filter((x) => x.code === "WXAML0008");
  if (dupKeyBad.length !== 1) fail(`expected exactly 1 WXAML0008 for the duplicated x:Key, got ${dupKeyBad.length}: ${JSON.stringify(dupKey.map((x) => `${x.code}:${x.message}`))}`);
  if (!/same key/i.test(dupKeyBad[0].message)) fail(`duplicate-key diagnostic should mention the same key was already added (got ${JSON.stringify(dupKeyBad[0].message)})`);
  if (dupKeyBad[0].severity !== 1) fail(`duplicate x:Key should be an error (severity 1), got ${dupKeyBad[0].severity}`);
  if (dupKey.length !== 1) fail(`expected exactly 1 total diagnostic (distinct key + the Page.Resources element must stay silent), got ${dupKey.length}: ${JSON.stringify(dupKey.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Key): duplicate 'Accent' -> 1 WXAML0008 (error); distinct key silent`);

  // 25d) The SAME x:Key in two DIFFERENT dictionaries (<Page.Resources> vs a nested <Grid.Resources>) is
  // NOT a collision — each dictionary is its own key scope. Proven with a genuine duplicate ('Dup') in the
  // page dictionary as the sentinel: exactly 1 WXAML0008 must fire (the cross-dictionary 'Shared' stays silent).
  const scopedKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Shared" Color="Red" />\n` +
    `    <SolidColorBrush x:Key="Dup" Color="Green" />\n` +
    `    <SolidColorBrush x:Key="Dup" Color="Blue" />\n  </Page.Resources>\n` +
    `  <Grid>\n    <Grid.Resources>\n      <SolidColorBrush x:Key="Shared" Color="Black" />\n    </Grid.Resources>\n  </Grid>\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "scoped-x-key");
  const scopedKeyBad = scopedKey.filter((x) => x.code === "WXAML0008");
  if (scopedKeyBad.length !== 1) fail(`per-dictionary keys must not collide: expected exactly 1 WXAML0008 (the page-dictionary 'Dup'), got ${scopedKeyBad.length}: ${JSON.stringify(scopedKey.map((x) => `${x.code}:${x.message}`))}`);
  console.log(`[ok] validation(x:Key): 'Shared' across <Page.Resources> and <Grid.Resources> -> silent; only page-dict 'Dup' fires`);

  // 25e) Duplicate x:Key expressed as an {x:Type Foo} implicit-style key is a collision too (VS-parity),
  // while a DISTINCT {x:Type} (TextBox) and a same-text STRING key ("Button", a separate key-space) must
  // NOT collide with it. Exactly 1 WXAML0008 must fire (the duplicated {x:Type Button}).
  const typeKey = await validateDoc(
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Page.Resources>\n` +
    `    <Style x:Key="{x:Type Button}" TargetType="Button" />\n` +
    `    <Style x:Key="{x:Type Button}" TargetType="Button" />\n` +
    `    <Style x:Key="{x:Type TextBox}" TargetType="TextBox" />\n` +
    `    <SolidColorBrush x:Key="Button" Color="Red" />\n  </Page.Resources>\n` +
    `  <Grid />\n</Page>`,
    (d) => d.some((x) => x.code === "WXAML0008"),
    "type-key-dup");
  const typeKeyBad = typeKey.filter((x) => x.code === "WXAML0008");
  if (typeKeyBad.length !== 1) fail(`{x:Type Button} duplicate should raise exactly 1 WXAML0008 (distinct {x:Type TextBox} and string key "Button" must not collide), got ${typeKeyBad.length}: ${JSON.stringify(typeKey.map((x) => `${x.code}:${x.message}`))}`);
  if (typeKeyBad[0].severity !== 1) fail(`duplicate {x:Type} key should be an error (severity 1), got ${typeKeyBad[0].severity}`);
  console.log(`[ok] validation(x:Key): duplicate '{x:Type Button}' -> 1 WXAML0008; distinct {x:Type TextBox} + string "Button" silent`);

  // 27) Find All References (textDocument/references), document-scoped. Driven on self-contained buffers
  //      (x:Name declaration + ElementName + Storyboard.TargetName usages; x:Key declaration + StaticResource
  //      + ThemeResource usages). Ranges are sliced back to text so assertions never hardcode positions.
  const nameBase =
    `<Page ${NS} xmlns:local="using:SmokeFixture" x:Class="SmokeFixture.SmokePage">\n` +
    `  <StackPanel>\n` +
    `    <Button x:Name="GoButton" Content="Go" />\n` +
    `    <TextBlock Text="{Binding ElementName=GoButton}" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="GoButton" Storyboard.TargetProperty="Opacity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>\n</Page>`;

  // 27a) caret ON the x:Name declaration, includeDeclaration=true -> declaration + both usages (3), all "GoButton".
  const nameDecl = await referencesWith(330, nameBase.replace('x:Name="GoButton"', 'x:Name="Go|Button"'), "name-decl", true);
  if (nameDecl.locations.length !== 3) fail(`references(x:Name decl, includeDecl): expected 3 (decl + ElementName + TargetName), got ${nameDecl.locations.length}: ${JSON.stringify(nameDecl.texts)}`);
  if (!nameDecl.texts.every((t) => t === "GoButton")) fail(`references(x:Name) should all read 'GoButton', got ${JSON.stringify(nameDecl.texts)}`);
  console.log(`[ok] references(x:Name decl): 3 locations (decl + ElementName + Storyboard.TargetName), all 'GoButton'`);

  // 27b) caret ON the ElementName usage, includeDeclaration=false -> both usages only (2), declaration excluded.
  const nameUse = await referencesWith(331, nameBase.replace("ElementName=GoButton}", "ElementName=GoBut|ton}"), "name-use-nodecl", false);
  if (nameUse.locations.length !== 2) fail(`references(x:Name usage, includeDecl=false): expected 2 usages (no declaration), got ${nameUse.locations.length}: ${JSON.stringify(nameUse.texts)}`);
  if (!nameUse.texts.every((t) => t === "GoButton")) fail(`references(x:Name usage) should all read 'GoButton', got ${JSON.stringify(nameUse.texts)}`);
  console.log(`[ok] references(x:Name usage, includeDecl=false): 2 usages, declaration excluded`);

  const resBase =
    `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n` +
    `  <Page.Resources>\n` +
    `    <SolidColorBrush x:Key="Brush1" Color="Red" />\n` +
    `  </Page.Resources>\n` +
    `  <StackPanel>\n` +
    `    <Border Background="{StaticResource Brush1}" />\n` +
    `    <Border Background="{ThemeResource Brush1}" />\n` +
    `  </StackPanel>\n</Page>`;

  // 27c) caret ON the x:Key declaration, includeDeclaration=true -> declaration + both usages (3), all "Brush1".
  const keyDecl = await referencesWith(332, resBase.replace('x:Key="Brush1"', 'x:Key="Bru|sh1"'), "key-decl", true);
  if (keyDecl.locations.length !== 3) fail(`references(x:Key decl, includeDecl): expected 3 (decl + StaticResource + ThemeResource), got ${keyDecl.locations.length}: ${JSON.stringify(keyDecl.texts)}`);
  if (!keyDecl.texts.every((t) => t === "Brush1")) fail(`references(x:Key) should all read 'Brush1', got ${JSON.stringify(keyDecl.texts)}`);
  console.log(`[ok] references(x:Key decl): 3 locations (decl + StaticResource + ThemeResource), all 'Brush1'`);

  // 27d) caret ON a {StaticResource} usage, includeDeclaration=false -> both usages only (2), declaration excluded.
  const keyUse = await referencesWith(333, resBase.replace("{StaticResource Brush1}", "{StaticResource Bru|sh1}"), "key-use-nodecl", false);
  if (keyUse.locations.length !== 2) fail(`references(x:Key usage, includeDecl=false): expected 2 usages (no declaration), got ${keyUse.locations.length}: ${JSON.stringify(keyUse.texts)}`);
  if (!keyUse.texts.every((t) => t === "Brush1")) fail(`references(x:Key usage) should all read 'Brush1', got ${JSON.stringify(keyUse.texts)}`);
  console.log(`[ok] references(x:Key usage, includeDecl=false): 2 usages, declaration excluded`);

  // 27e) caret NOT on a reference (a plain element tag) -> no references.
  const noRef = await referencesWith(334, nameBase.replace("<StackPanel>", "<StackPa|nel>"), "no-ref", true);
  if (noRef.locations.length !== 0) fail(`references(non-reference caret): expected 0, got ${noRef.locations.length}: ${JSON.stringify(noRef.texts)}`);
  console.log(`[ok] references(non-reference caret): 0 locations`);

  // 27f) ROUND 79: cross-file resource-key Find All References. SmokeAccentBrush is DECLARED in App.xaml and USED across pages (SmokePage, DiPage), so references must span the whole project (read-only), not just the open document. Restore the real SmokePage buffer first (earlier cases mutated it), then reference the real {StaticResource SmokeAccentBrush} usage.
  send({ method: "textDocument/didChange", params: { textDocument: { uri: xamlUri, version: nextVersion() }, contentChanges: [{ text: xamlText }] } });
  send({ id: 524, method: "textDocument/references", params: { textDocument: { uri: xamlUri }, position: resCaret, context: { includeDeclaration: true } } });
  const xref = await waitFor(responseFor(524), 30000, "xref-with-decl");
  if (xref.error) fail(`cross-file references errored: ${JSON.stringify(xref.error)}`);
  const xrefLocs = Array.isArray(xref.result) ? xref.result : [];
  const uriEndsWith = (needle) => xrefLocs.filter((l) => l.uri.toLowerCase().endsWith(needle)).length;
  if (xrefLocs.some((l) => /[\\/]obj[\\/]/i.test(decodeURIComponent(l.uri)))) {
    fail(`cross-file refs leaked a build-output (obj) copy: ${JSON.stringify(xrefLocs.map((l) => l.uri))}`);
  }
  if (xrefLocs.length !== 5) {
    fail(`cross-file references(SmokeAccentBrush, includeDecl): expected 5 (3 SmokePage + 1 App decl + 1 DiPage), got ${xrefLocs.length}: ${JSON.stringify(xrefLocs.map((l) => `${l.uri}@${l.range.start.line}`))}`);
  }
  if (uriEndsWith("smokepage.xaml") !== 3) fail(`expected 3 SmokePage usages, got ${uriEndsWith("smokepage.xaml")}`);
  if (uriEndsWith("app.xaml") !== 1) fail(`expected 1 App.xaml declaration, got ${uriEndsWith("app.xaml")}`);
  if (uriEndsWith("dipage.xaml") !== 1) fail(`expected 1 DiPage usage, got ${uriEndsWith("dipage.xaml")}`);
  console.log(`[ok] references(cross-file SmokeAccentBrush, includeDecl): 5 across SmokePage(3)+App.xaml(1 decl)+DiPage(1), no obj`);

  // includeDeclaration=false drops the App.xaml x:Key DECLARATION cross-file -> 4 usages (3 SmokePage + 1 DiPage).
  send({ id: 525, method: "textDocument/references", params: { textDocument: { uri: xamlUri }, position: resCaret, context: { includeDeclaration: false } } });
  const xref2 = await waitFor(responseFor(525), 30000, "xref-no-decl");
  if (xref2.error) fail(`cross-file references(no decl) errored: ${JSON.stringify(xref2.error)}`);
  const xref2Locs = Array.isArray(xref2.result) ? xref2.result : [];
  if (xref2Locs.length !== 4) {
    fail(`cross-file references(no decl): expected 4 usages (App.xaml decl excluded), got ${xref2Locs.length}: ${JSON.stringify(xref2Locs.map((l) => l.uri))}`);
  }
  if (xref2Locs.some((l) => l.uri.toLowerCase().endsWith("app.xaml"))) {
    fail(`includeDeclaration=false must exclude the App.xaml declaration, got ${JSON.stringify(xref2Locs.map((l) => l.uri))}`);
  }
  console.log(`[ok] references(cross-file, includeDecl=false): 4 usages, App.xaml declaration excluded`);

  // 28) Document Highlights (textDocument/documentHighlight): the same occurrences as references, rendered
  //     as editor highlights. Declaration is a Write highlight (kind 3); usages are Read highlights (kind 2).
  // 28a) x:Name: caret on a usage highlights declaration (Write) + both usages (Read) = 3, all "GoButton".
  const nameHl = await highlightWith(335, nameBase.replace("ElementName=GoButton}", "ElementName=GoBut|ton}"), "name-highlight");
  if (nameHl.highlights.length !== 3) fail(`highlight(x:Name): expected 3 (decl + 2 usages), got ${nameHl.highlights.length}: ${JSON.stringify(nameHl.texts)}`);
  if (!nameHl.texts.every((t) => t === "GoButton")) fail(`highlight(x:Name) should all read 'GoButton', got ${JSON.stringify(nameHl.texts)}`);
  if (nameHl.kinds.filter((k) => k === 3).length !== 1) fail(`highlight(x:Name): expected exactly 1 Write (declaration) kind, got kinds ${JSON.stringify(nameHl.kinds)}`);
  if (nameHl.kinds.filter((k) => k === 2).length !== 2) fail(`highlight(x:Name): expected 2 Read (usage) kinds, got kinds ${JSON.stringify(nameHl.kinds)}`);
  console.log(`[ok] highlight(x:Name usage caret): 3 highlights (1 Write decl + 2 Read usages), all 'GoButton'`);

  // 28b) resource key: caret on the x:Key declaration highlights decl (Write) + both usages (Read) = 3.
  const keyHl = await highlightWith(336, resBase.replace('x:Key="Brush1"', 'x:Key="Bru|sh1"'), "key-highlight");
  if (keyHl.highlights.length !== 3) fail(`highlight(x:Key): expected 3 (decl + 2 usages), got ${keyHl.highlights.length}: ${JSON.stringify(keyHl.texts)}`);
  if (!keyHl.texts.every((t) => t === "Brush1")) fail(`highlight(x:Key) should all read 'Brush1', got ${JSON.stringify(keyHl.texts)}`);
  if (keyHl.kinds.filter((k) => k === 3).length !== 1) fail(`highlight(x:Key): expected exactly 1 Write (declaration) kind, got kinds ${JSON.stringify(keyHl.kinds)}`);
  console.log(`[ok] highlight(x:Key decl caret): 3 highlights (1 Write decl + 2 Read usages), all 'Brush1'`);

  // 28c) caret NOT on a symbol -> no highlights.
  const noHl = await highlightWith(337, nameBase.replace("<StackPanel>", "<StackPa|nel>"), "no-highlight");
  if (noHl.highlights.length !== 0) fail(`highlight(non-symbol caret): expected 0, got ${noHl.highlights.length}: ${JSON.stringify(noHl.texts)}`);
  console.log(`[ok] highlight(non-symbol caret): 0 highlights`);

  Object.assign(ctx, { pageRes, pageCls, ev, sb, docSymbols, outline, validateDoc, undeclared });
}
