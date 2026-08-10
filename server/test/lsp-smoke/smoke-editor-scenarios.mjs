export async function runEditorScenarios(ctx) {
  const {
    fail, xamlText, xamlUri, XAML, NS, pageRes, pageCls, sb, validateDoc,
    formatWith, foldingWith, documentColorWith, colorPresentationWith,
    selectionRangeWith, linkedEditingWith, documentLinkWith, prepareRenameWith,
    renameWith, semanticTokensWith, semanticTokensRangeWith, decodeSemanticTokens,
    codeActionWith, completeWith, completeItemsWith, hoverAt, definitionWith,
    referencesWith, positionToOffset,
  } = ctx;

  const fmtMessy = "<Page>\n<Grid>\n<Button />\n</Grid>\n</Page>";
  const fmtExpected = "<Page>\n  <Grid>\n    <Button />\n  </Grid>\n</Page>";
  const fmtRes = await formatWith(338, fmtMessy, "reindent");
  if (fmtRes.formatted !== fmtExpected) fail(`formatting(reindent): got ${JSON.stringify(fmtRes.formatted)}`);
  console.log(`[ok] formatting(reindent): nested tags -> 2-space depth (${fmtRes.edits.length} edits)`);

  const fmtPreserve = '<Page>\n<TextBlock xml:space="preserve">\n      keep  this\n   text</TextBlock>\n</Page>';
  const preRes = await formatWith(339, fmtPreserve, "preserve");
  if (!preRes.formatted.includes("\n      keep  this\n   text</TextBlock>"))
    fail(`formatting(preserve): significant whitespace changed: ${JSON.stringify(preRes.formatted)}`);
  if (!preRes.formatted.includes('  <TextBlock xml:space="preserve">'))
    fail(`formatting(preserve): open tag not reindented: ${JSON.stringify(preRes.formatted)}`);
  console.log(`[ok] formatting(preserve): xml:space content byte-preserved, open tag reindented`);

  const cleanRes = await formatWith(340, fmtExpected, "idempotent");
  if (cleanRes.edits.length !== 0) fail(`formatting(idempotent): expected 0 edits, got ${cleanRes.edits.length}`);
  console.log(`[ok] formatting(idempotent): already-formatted -> 0 edits`);

  // 14c) folding — multi-line elements + a #region/#endregion pair
  const foldBody = "<Grid>\n  <StackPanel>\n    <Button />\n  </StackPanel>\n</Grid>";
  const folds = await foldingWith(341, foldBody, "elements");
  const gridFold = folds.find((f) => f.startLine === 0);
  if (!gridFold || gridFold.endLine !== 4) fail(`folding(elements): expected <Grid> fold [0,4], got ${JSON.stringify(folds)}`);
  const spFold = folds.find((f) => f.startLine === 1);
  if (!spFold || spFold.endLine !== 3) fail(`folding(elements): expected <StackPanel> fold [1,3], got ${JSON.stringify(folds)}`);
  if (folds.some((f) => f.endLine <= f.startLine)) fail(`folding(elements): inverted/degenerate range: ${JSON.stringify(folds)}`);
  console.log(`[ok] folding(elements): nested element folds [0,4] + [1,3]`);

  const regionBody = "<Grid>\n  <!-- #region Buttons -->\n  <Button />\n  <!-- #endregion -->\n</Grid>";
  const regionFolds = await foldingWith(342, regionBody, "region");
  const region = regionFolds.find((f) => f.kind === "region");
  if (!region || region.startLine !== 1 || region.endLine !== 3)
    fail(`folding(region): expected region fold [1,3], got ${JSON.stringify(regionFolds)}`);
  console.log(`[ok] folding(region): #region/#endregion fold [1,3] kind=region`);

  // 15) document color — hex literals become swatches; non-color values do not
  const colorBody = `<Page ${NS}>\n  <Rectangle Fill="#FF3B82F6" />\n  <TextBlock Text="not a color" />\n  <Border Background="{StaticResource Brush1}" />\n</Page>`;
  const colors = await documentColorWith(343, colorBody, "hex");
  if (colors.length !== 1) fail(`documentColor: expected exactly 1 swatch, got ${colors.length}: ${JSON.stringify(colors)}`);
  const swatch = colors[0];
  if (swatch.range.start.line !== 1) fail(`documentColor: swatch on wrong line: ${JSON.stringify(swatch.range)}`);
  // #FF3B82F6 -> alpha FF, r 0x3B, g 0x82, b 0xF6
  const near = (a, b) => Math.abs(a - b) < 0.01;
  if (!near(swatch.color.alpha, 1.0) || !near(swatch.color.red, 0x3b / 255) ||
      !near(swatch.color.green, 0x82 / 255) || !near(swatch.color.blue, 0xf6 / 255))
    fail(`documentColor: wrong color channels: ${JSON.stringify(swatch.color)}`);
  console.log(`[ok] documentColor: exactly 1 swatch for #FF3B82F6 (text + {StaticResource} ignored)`);

  // 15b) color presentation — a picked opaque color round-trips and stays bounded to the literal's range
  const pres = await colorPresentationWith(
    344,
    { red: 0x3b / 255, green: 0x82 / 255, blue: 0xf6 / 255, alpha: 1.0 },
    swatch.range,
    "opaque",
  );
  if (!pres.some((p) => p.label === "#3B82F6")) fail(`colorPresentation: missing #3B82F6: ${JSON.stringify(pres)}`);
  if (!pres.some((p) => p.label === "#FF3B82F6")) fail(`colorPresentation: missing #FF3B82F6: ${JSON.stringify(pres)}`);
  for (const p of pres) {
    if (!p.textEdit) fail(`colorPresentation: presentation '${p.label}' has no textEdit`);
    if (p.textEdit.range.start.character !== swatch.range.start.character ||
        p.textEdit.range.end.character !== swatch.range.end.character)
      fail(`colorPresentation: edit range must equal the literal range: ${JSON.stringify(p.textEdit.range)}`);
  }
  console.log(`[ok] colorPresentation: opaque -> #3B82F6 + #FF3B82F6, edits bounded to the literal`);

  // 15c) color presentation — a translucent picked color offers #AARRGGBB first
  const presA = await colorPresentationWith(
    345,
    { red: 1.0, green: 0.0, blue: 0.0, alpha: 0x80 / 255 },
    swatch.range,
    "translucent",
  );
  if (presA[0].label !== "#80FF0000") fail(`colorPresentation(translucent): expected #80FF0000 first, got ${JSON.stringify(presA)}`);
  console.log(`[ok] colorPresentation: translucent -> #80FF0000 offered first`);

  // 16) selection range — expand/shrink selection walks the syntax tree, strictly nested
  const selBody = `<Page ${NS}>\n  <Grid Background="#FF0000" />\n</Page>`;
  const gridLine = selBody.split("\n")[1];
  const selCol = gridLine.indexOf("#FF0000") + 2; // caret inside the color literal
  const selRanges = await selectionRangeWith(346, selBody, [{ line: 1, character: selCol }], "color");
  if (selRanges.length !== 1) fail(`selectionRange: expected 1 result, got ${selRanges.length}`);
  // flatten the parent chain and assert strict containment + document-sized outermost
  const flat = [];
  for (let cur = selRanges[0]; cur; cur = cur.parent) flat.push(cur.range);
  if (flat.length < 3) fail(`selectionRange: expected several nested levels, got ${flat.length}: ${JSON.stringify(flat)}`);
  const inDoc = (r) => r.start.line === 1 && r.start.character <= selCol && r.end.character >= selCol;
  if (!inDoc(flat[0])) fail(`selectionRange: innermost must contain the caret: ${JSON.stringify(flat[0])}`);
  for (let i = 0; i + 1 < flat.length; i++) {
    const inner = flat[i];
    const outer = flat[i + 1];
    const contains =
      (outer.start.line < inner.start.line ||
        (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
      (outer.end.line > inner.end.line ||
        (outer.end.line === inner.end.line && outer.end.character >= inner.end.character));
    if (!contains) fail(`selectionRange: level ${i + 1} must contain level ${i}: ${JSON.stringify({ inner, outer })}`);
  }
  const outermost = flat[flat.length - 1];
  if (outermost.start.line !== 0 || outermost.start.character !== 0)
    fail(`selectionRange: outermost must be the whole document, got ${JSON.stringify(outermost)}`);
  console.log(`[ok] selectionRange: ${flat.length} strictly-nested levels, outermost = whole document`);

  // 17) linked editing — the caret on an element's open tag name returns both the open and end tag
  // name ranges so VS Code renames the matching tag as the user types.
  const leBody = `<Page ${NS}>\n  <StackPanel>\n    <Button />\n  </StackPanel>\n</Page>`;
  const leOpenCol = leBody.split("\n")[1].indexOf("StackPanel") + 3; // caret inside the open <StackPanel>
  const leOpen = await linkedEditingWith(347, leBody, { line: 1, character: leOpenCol }, "open tag");
  if (!leOpen || !Array.isArray(leOpen.ranges) || leOpen.ranges.length !== 2)
    fail(`linkedEditingRange: expected 2 ranges on open tag, got ${JSON.stringify(leOpen)}`);
  const textAt = (r) => {
    const lines = leBody.split("\n");
    if (r.start.line !== r.end.line) return "<multi-line>";
    return lines[r.start.line].slice(r.start.character, r.end.character);
  };
  if (textAt(leOpen.ranges[0]) !== "StackPanel" || textAt(leOpen.ranges[1]) !== "StackPanel")
    fail(`linkedEditingRange: ranges must cover both StackPanel names, got ${JSON.stringify(leOpen.ranges.map(textAt))}`);
  // open range (line 1) precedes the end range (line 3)
  if (!(leOpen.ranges[0].start.line < leOpen.ranges[1].start.line))
    fail(`linkedEditingRange: open name must precede end name, got ${JSON.stringify(leOpen.ranges)}`);
  // a self-closing tag has nothing to link -> null
  const leSelf = await linkedEditingWith(348, leBody, { line: 2, character: leBody.split("\n")[2].indexOf("Button") + 2 }, "self-closing");
  if (leSelf !== null && !(leSelf && leSelf.ranges && leSelf.ranges.length === 0))
    fail(`linkedEditingRange: self-closing <Button /> must not link, got ${JSON.stringify(leSelf)}`);
  console.log(`[ok] linkedEditingRange: open tag -> both StackPanel names linked; self-closing -> none`);

  // 18) document links — ctrl+click a ResourceDictionary Source that exists on disk (the fixture's
  // App.xaml, next to SmokePage.xaml) yields a file link over exactly the path token; ms-appx:/// resolves
  // under the project root (same fixture dir); a missing target yields no link.
  const dlBody = `<ResourceDictionary Source="App.xaml" />`;
  const dlLinks = await documentLinkWith(349, dlBody, "existing Source");
  if (dlLinks.length !== 1) fail(`documentLink: expected 1 link for existing App.xaml, got ${JSON.stringify(dlLinks)}`);
  if (!dlLinks[0].target || !/\/App\.xaml$/i.test(decodeURIComponent(dlLinks[0].target)))
    fail(`documentLink: target must point at App.xaml, got ${JSON.stringify(dlLinks[0])}`);
  const dlRange = dlLinks[0].range;
  if (dlBody.slice(dlRange.start.character, dlRange.end.character) !== "App.xaml")
    fail(`documentLink: range must cover the path token "App.xaml", got ${JSON.stringify(dlRange)}`);
  const dlAppx = await documentLinkWith(350, `<ResourceDictionary Source="ms-appx:///App.xaml" />`, "ms-appx Source");
  if (dlAppx.length !== 1 || !/\/App\.xaml$/i.test(decodeURIComponent(dlAppx[0].target || "")))
    fail(`documentLink: ms-appx:///App.xaml must resolve under the project root, got ${JSON.stringify(dlAppx)}`);
  const dlMissing = await documentLinkWith(351, `<ResourceDictionary Source="DoesNotExist.xaml" />`, "missing Source");
  if (dlMissing.length !== 0) fail(`documentLink: a missing target must not link, got ${JSON.stringify(dlMissing)}`);
  console.log(`[ok] documentLink: existing/ms-appx ResourceDictionary Source -> file link; missing -> none`);

  // 18b) asset document links — Image/BitmapImage sources resolve app-root-relative (ms-appx:/// semantics)
  // to real files under the fixture's Assets folder, over exactly the path token.
  const dlImgBody = `<Image Source="Assets/StoreLogo.png" />`;
  const dlImg = await documentLinkWith(352, dlImgBody, "Image asset Source");
  if (dlImg.length !== 1 || !/\/Assets\/StoreLogo\.png$/i.test(decodeURIComponent(dlImg[0].target || "")))
    fail(`documentLink: Image Source="Assets/StoreLogo.png" must link the real asset, got ${JSON.stringify(dlImg)}`);
  if (dlImgBody.slice(dlImg[0].range.start.character, dlImg[0].range.end.character) !== "Assets/StoreLogo.png")
    fail(`documentLink: range must cover the asset path token, got ${JSON.stringify(dlImg[0].range)}`);
  const dlBmp = await documentLinkWith(353, `<BitmapImage UriSource="ms-appx:///Assets/StoreLogo.png" />`, "BitmapImage UriSource");
  if (dlBmp.length !== 1 || !/\/Assets\/StoreLogo\.png$/i.test(decodeURIComponent(dlBmp[0].target || "")))
    fail(`documentLink: BitmapImage UriSource ms-appx must resolve under the package root, got ${JSON.stringify(dlBmp)}`);
  console.log(`[ok] documentLink: Image/BitmapImage asset sources -> real Assets file link (app-root)`);

  // 19) rename (F2) — prepareRename validates the caret token (placeholder + tight range) and rename
  // rewrites the x:Name declaration plus every reference; an invalid identifier is rejected with an error,
  // and a caret on a non-symbol (the element name) is not renameable.
  const rnBody = `<Grid x:Name="Root"><TextBox Text="{Binding ElementName=Root}" /></Grid>`;
  const rnPos = { line: 0, character: 16 }; // inside the x:Name="Root" declaration
  const rnPrep = await prepareRenameWith(360, rnBody, rnPos, "x:Name decl");
  if (!rnPrep || rnPrep.placeholder !== "Root")
    fail(`prepareRename: expected placeholder "Root", got ${JSON.stringify(rnPrep)}`);
  if (rnBody.slice(rnPrep.range.start.character, rnPrep.range.end.character) !== "Root")
    fail(`prepareRename: range must cover "Root", got ${JSON.stringify(rnPrep.range)}`);
  const rnOk = await renameWith(361, rnBody, rnPos, "Panel", "x:Name -> Panel");
  if (rnOk.error) fail(`rename: unexpected error ${JSON.stringify(rnOk.error)}`);
  const rnChanges = rnOk.result && rnOk.result.changes ? Object.values(rnOk.result.changes) : [];
  const rnEdits = rnChanges.length === 1 ? rnChanges[0] : [];
  if (rnEdits.length !== 2)
    fail(`rename: expected 2 edits (decl + ElementName usage), got ${JSON.stringify(rnOk.result)}`);
  if (!rnEdits.every((e) => e.newText === "Panel"))
    fail(`rename: every edit must set newText "Panel", got ${JSON.stringify(rnEdits)}`);
  if (!rnEdits.every((e) => rnBody.slice(e.range.start.character, e.range.end.character) === "Root"))
    fail(`rename: every edit range must cover the old name "Root", got ${JSON.stringify(rnEdits)}`);
  const rnBad = await renameWith(362, rnBody, rnPos, "1Bad", "invalid identifier");
  if (!rnBad.error)
    fail(`rename: an invalid identifier must be rejected with an error, got ${JSON.stringify(rnBad.result)}`);
  const rnNon = await prepareRenameWith(363, rnBody, { line: 0, character: 2 }, "element name");
  if (rnNon !== null)
    fail(`prepareRename: a caret on the element name must not be renameable, got ${JSON.stringify(rnNon)}`);
  console.log(`[ok] rename: prepareRename validates x:Name; rename rewrites decl+usage; invalid name rejected; non-symbol -> null`);

  // 19b) ROUND 80: element-name reference nav + rename now recognize RelativePanel alignment attached properties (bare-name, like Storyboard.TargetName) AND VSM <Setter Target="Element.Property"> (only the pre-dot element segment). Before this, renaming an x:Name silently left these dangling. F12 on a RelativePanel.RightOf value navigates to the referenced x:Name declaration (line 1, not the usage).
  const rpBody =
    "<RelativePanel>\n" +
    '  <TextBox x:Name="Anchor" />\n' +
    '  <Button RelativePanel.RightOf="An|chor" />\n' +
    "</RelativePanel>";
  const rpDef = await definitionWith(526, rpBody, "RelativePanel.RightOf F12");
  if (!rpDef || rpDef.range.start.line !== 1)
    fail(`definition(RelativePanel.RightOf): expected the x:Name decl on line 1, got ${JSON.stringify(rpDef)}`);
  console.log(`[ok] definition(RelativePanel.RightOf): navigates to the x:Name="Anchor" declaration`);

  // References on the x:Name decl include BOTH RelativePanel alignment usages (RightOf + AlignTopWith).
  const rpRefBody =
    "<RelativePanel>\n" +
    '  <TextBox x:Name="An|chor" />\n' +
    '  <Button RelativePanel.RightOf="Anchor" RelativePanel.AlignTopWith="Anchor" />\n' +
    "</RelativePanel>";
  const rpRefs = await referencesWith(527, rpRefBody, "RelativePanel refs", true);
  if (rpRefs.locations.length !== 3)
    fail(`references(RelativePanel x:Name): expected 3 (decl + RightOf + AlignTopWith), got ${rpRefs.locations.length}: ${JSON.stringify(rpRefs.texts)}`);
  if (!rpRefs.texts.every((t) => t === "Anchor"))
    fail(`references(RelativePanel) should all read 'Anchor', got ${JSON.stringify(rpRefs.texts)}`);
  console.log(`[ok] references(RelativePanel x:Name): 3 (decl + RightOf + AlignTopWith), all 'Anchor'`);

  // F12 on the ELEMENT segment of a VSM Setter.Target navigates to the x:Name declaration (line 1).
  const stgBody =
    "<Page>\n" +
    '  <Border x:Name="Hero" />\n' +
    '  <Setter Target="He|ro.Background" Value="Red" />\n' +
    "</Page>";
  const stgDef = await definitionWith(528, stgBody, "Setter.Target F12");
  if (!stgDef || stgDef.range.start.line !== 1)
    fail(`definition(Setter.Target element): expected the x:Name decl on line 1, got ${JSON.stringify(stgDef)}`);
  console.log(`[ok] definition(Setter.Target element segment): navigates to the x:Name="Hero" declaration`);

  // THE RAZOR: renaming the x:Name rewrites the Setter.Target ELEMENT segment only — every edit covers exactly
  // "Hero", never "Hero.Background", so the ".Background" property tail is preserved.
  const stgRnBody =
    "<Page>\n" +
    '  <Border x:Name="Hero" />\n' +
    '  <Setter Target="Hero.Background" Value="Red" />\n' +
    "</Page>";
  const stgRn = await renameWith(529, stgRnBody, { line: 1, character: 19 }, "Banner", "Setter.Target rename");
  if (stgRn.error) fail(`rename(Setter.Target): unexpected error ${JSON.stringify(stgRn.error)}`);
  const stgChanges = stgRn.result && stgRn.result.changes ? Object.values(stgRn.result.changes) : [];
  const stgEdits = stgChanges.length === 1 ? stgChanges[0] : [];
  if (stgEdits.length !== 2)
    fail(`rename(Setter.Target): expected 2 edits (decl + Target element), got ${JSON.stringify(stgRn.result)}`);
  if (!stgEdits.every((e) => e.newText === "Banner"))
    fail(`rename(Setter.Target): every edit must set newText "Banner", got ${JSON.stringify(stgEdits)}`);
  const stgLines = stgRnBody.split("\n");
  if (!stgEdits.every((e) => stgLines[e.range.start.line].slice(e.range.start.character, e.range.end.character) === "Hero"))
    fail(`rename(Setter.Target): every edit must cover exactly "Hero" (not "Hero.Background"), got ${JSON.stringify(stgEdits)}`);
  console.log(`[ok] rename(Setter.Target): 2 edits, both cover exactly "Hero" — ".Background" preserved`);

  // NEGATIVE: a caret on the ".Property" tail is NOT a name reference (it's a member on Hero) -> not renameable.
  const stgProp = await prepareRenameWith(530, stgRnBody, { line: 2, character: 27 }, "Setter.Target .Property");
  if (stgProp !== null)
    fail(`prepareRename(Setter.Target .Property): the property tail must not be renameable, got ${JSON.stringify(stgProp)}`);
  console.log(`[ok] prepareRename(Setter.Target .Property tail): null — the member is not an element-name reference`);

  // 19c) ROUND 81: F12 + hover on the MEMBER segment of a VSM <Setter Target="Element.Property"> value, and a bare Storyboard.TargetProperty="Property" value -> the property on the target element's type, symmetric with <Setter Property="...">. Round 80 shipped the pre-dot ELEMENT reference nav/rename; round 81 resolves the post-dot MEMBER. Framework members resolve for HOVER but have no source location, so F12 returns null there (the documented metadata boundary) — and a member caret must NOT fall through to the round-80 element F12 (which would wrongly navigate to the x:Name declaration).
  const vsmSetterTarget = (target) =>
    pageCls(`<Border x:Name="Chrome" />\n  <Setter Target="${target}" Value="0.5" />`);

  // Hover on the Setter.Target member resolves the property on the named element's type (Border -> UIElement.Opacity).
  const stmHover = await hoverAt(531, vsmSetterTarget("Chrome.Opac|ity"), "Setter.Target member hover");
  if (!/Opacity/.test(stmHover) || !/(UIElement|double|Double)/.test(stmHover))
    fail(`hover(Setter.Target member): expected Border's Opacity property, got ${JSON.stringify(stmHover)}`);
  console.log(`[ok] hover(Setter.Target member 'Chrome.Opacity'): resolves the Opacity property on the target element's type`);

  // F12 on the member (framework property) returns null gracefully — and crucially does NOT navigate to the
  // x:Name declaration (that is the round-80 pre-dot ELEMENT behavior; the member caret must fall through it).
  const stmMemberDef = await definitionWith(532, vsmSetterTarget("Chrome.Opac|ity"), "Setter.Target member F12");
  if (stmMemberDef !== null)
    fail(`definition(Setter.Target member): a framework member has no source + must not hit the x:Name decl, got ${JSON.stringify(stmMemberDef)}`);
  // The ELEMENT segment still navigates to the decl (round-80 caret-precision razor re-confirmed with a member tail).
  const stmElemDef = await definitionWith(533, vsmSetterTarget("Chr|ome.Opacity"), "Setter.Target element F12");
  if (!stmElemDef || stmElemDef.range.start.line !== 1)
    fail(`definition(Setter.Target element w/ member tail): expected the x:Name decl on line 1, got ${JSON.stringify(stmElemDef)}`);
  console.log(`[ok] definition(Setter.Target): member caret -> null (framework, graceful; not the decl); element caret -> x:Name decl (round-80 intact)`);

  // Hover on a bare Storyboard.TargetProperty member resolves against the sibling Storyboard.TargetName element.
  const sbtpBody = pageCls(
    `<StackPanel>\n` +
    `    <Border x:Name="Chrome" />\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetName="Chrome" Storyboard.TargetProperty="Opac|ity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>`);
  const sbtpHover = await hoverAt(534, sbtpBody, "Storyboard.TargetProperty member hover");
  if (!/Opacity/.test(sbtpHover) || !/(UIElement|double|Double)/.test(sbtpHover))
    fail(`hover(Storyboard.TargetProperty member): expected the sibling TargetName element's Opacity, got ${JSON.stringify(sbtpHover)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty 'Opacity'): resolves against the sibling Storyboard.TargetName element`);

  // Round-81 follow-up fix: with NO sibling Storyboard.TargetName the value has no target, so a bare member
  // must NOT leak to the generic page-class member fallback (which would else mis-hover "Opacity" as the
  // page's own UIElement.Opacity). Same buffer minus the TargetName -> silent.
  const sbtpNoTargetBody = pageCls(
    `<StackPanel>\n` +
    `    <Storyboard>\n` +
    `      <DoubleAnimation Storyboard.TargetProperty="Opac|ity" />\n` +
    `    </Storyboard>\n` +
    `  </StackPanel>`);
  const sbtpNoTargetHover = await hoverAt(535, sbtpNoTargetBody, "Storyboard.TargetProperty no-target hover");
  if (sbtpNoTargetHover !== "")
    fail(`hover(Storyboard.TargetProperty no target): expected no hover (no target element), got ${JSON.stringify(sbtpNoTargetHover)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty 'Opacity' w/o TargetName): silent — no page-member leak`);

  // 19d) ROUND 82: F12 + hover on the PROPERTY argument of a {TemplateBinding Property} inside a ControlTemplate -> the property on the template's TargetType (the templated parent). Symmetric with the round-4 TemplateBinding COMPLETION, which already offers those same properties (both reuse ResolveStyleTargetType). Framework members resolve for HOVER but have no source location, so F12 returns null (the documented metadata boundary). The extension NAME hover ("TemplateBinding" macro description) must be UNCHANGED — it is handled earlier by ResolveValueHoverAsync and only fires when the caret is on the name.
  const tbTemplate = (inner) => pageCls(
    `<Page.Resources>\n` +
    `    <Style TargetType="Button">\n` +
    `      <Setter Property="Template">\n` +
    `        <Setter.Value>\n` +
    `          <ControlTemplate TargetType="Button">\n` +
    `            ${inner}\n` +
    `          </ControlTemplate>\n` +
    `        </Setter.Value>\n` +
    `      </Setter>\n` +
    `    </Style>\n` +
    `  </Page.Resources>`);

  // Hover on the TemplateBinding property resolves the member on the template's TargetType (Button -> Control.Background).
  const tbHover = await hoverAt(536, tbTemplate('<Border Background="{TemplateBinding Back|ground}" />'), "TemplateBinding member hover");
  if (!/Background/.test(tbHover) || !/(Control|Brush)/.test(tbHover))
    fail(`hover(TemplateBinding member): expected the Button's Background property, got ${JSON.stringify(tbHover)}`);
  console.log(`[ok] hover(TemplateBinding 'Background'): resolves the property on the template's TargetType`);

  // F12 on the member (a framework property) returns null gracefully — no source location.
  const tbDef = await definitionWith(537, tbTemplate('<Border Background="{TemplateBinding Back|ground}" />'), "TemplateBinding member F12");
  if (tbDef !== null)
    fail(`definition(TemplateBinding member): a framework member has no source, expected null, got ${JSON.stringify(tbDef)}`);
  console.log(`[ok] definition(TemplateBinding 'Background'): null (framework member, graceful metadata boundary)`);

  // Caret on the extension NAME still shows the macro description, NOT a member (ResolveValueHoverAsync wins there).
  const tbNameHover = await hoverAt(538, tbTemplate('<Border Background="{Templ|ateBinding Background}" />'), "TemplateBinding name hover");
  if (!/TemplateBinding/.test(tbNameHover) || !/templated (control|parent)/i.test(tbNameHover))
    fail(`hover(TemplateBinding name): expected the macro description (unchanged), got ${JSON.stringify(tbNameHover)}`);
  console.log(`[ok] hover(TemplateBinding name): macro description preserved (no member conflict)`);

  // A property that is NOT on the TargetType -> silent (FindMember null, no leak to a page/other member).
  const tbBogus = await hoverAt(539, tbTemplate('<Border Background="{TemplateBinding Zork|le}" />'), "TemplateBinding bogus member");
  if (tbBogus !== "")
    fail(`hover(TemplateBinding bogus member): expected no hover, got ${JSON.stringify(tbBogus)}`);
  console.log(`[ok] hover(TemplateBinding 'Zorkle'): silent — unknown member on the TargetType`);

  // Caret precision: genuine interior whitespace (a caret BEFORE the member start, not at its edge) resolves
  // nothing — the value span excludes leading/trailing whitespace, so the hit-test is exact, not greedy. This
  // is the round-82 precision invariant most likely to silently regress if the hit-test is ever widened.
  const tbSpace = await hoverAt(540, tbTemplate('<Border Background="{TemplateBinding | Background}" />'), "TemplateBinding whitespace caret");
  if (tbSpace !== "")
    fail(`hover(TemplateBinding whitespace): a caret in interior whitespace must not resolve, got ${JSON.stringify(tbSpace)}`);
  console.log(`[ok] hover(TemplateBinding interior whitespace): silent — value span excludes whitespace (exact hit-test)`);

  // 19e) ROUND 83: F12 + hover on the MEMBER (or owner type) of a parenthesized (Owner.Property) qualifier inside Storyboard.TargetProperty — the read-side counterpart of the round-77 qualified-group COMPLETION (both resolve the EXPLICITLY named owner type, independently of Storyboard.TargetName). A member caret resolves an INSTANCE property or an ATTACHED property of the owner; an owner caret resolves the owner TYPE. Framework members/types have no source, so F12 returns null (the documented metadata boundary). Reuses the round-77 sb(tp) fixture helper (Border "AttachedProbe" + DoubleAnimation). (i) instance-member caret -> the property on the explicit owner type (UIElement.Opacity, double).
  const q1 = await hoverAt(541, sb("(UIElement.Opac|ity)"), "sb-nav-instance-member");
  if (!/Opacity/.test(q1) || !/UIElement/.test(q1))
    fail(`hover((UIElement.Opacity) member): expected UIElement.Opacity, got ${JSON.stringify(q1)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(UIElement.Opacity)'): instance member on the explicit owner`);

  // (ii) attached-member caret -> the "(attached property) T Owner.Member" framing (Canvas.Left, double).
  const q2 = await hoverAt(542, sb("(Canvas.Le|ft)"), "sb-nav-attached-member");
  if (!/attached property/.test(q2) || !/Canvas\.Left/.test(q2))
    fail(`hover((Canvas.Left) member): expected the attached-property framing, got ${JSON.stringify(q2)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(Canvas.Left)'): attached-property framing`);

  // (iii) owner-segment caret -> the owner TYPE (like {x:Type}), NOT the member.
  const q3 = await hoverAt(543, sb("(UIEle|ment.Opacity)"), "sb-nav-owner-type");
  if (!/class/.test(q3) || !/UIElement/.test(q3))
    fail(`hover((UIElement.Opacity) owner): expected the UIElement type, got ${JSON.stringify(q3)}`);
  if (/attached property/.test(q3) || /\bOpacity\b/.test(q3))
    fail(`hover((UIElement.Opacity) owner): must resolve the TYPE, not the member, got ${JSON.stringify(q3)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(UIElement.Opacity)' owner caret): the owner type`);

  // (iv) chained group: the SECOND group's member resolves against ITS explicit owner (CompositeTransform.TranslateX).
  const q4 = await hoverAt(544, sb("(UIElement.RenderTransform).(CompositeTransform.Trans|lateX)"), "sb-nav-chained-member");
  if (!/TranslateX/.test(q4) || !/CompositeTransform/.test(q4))
    fail(`hover(chained (…).(CompositeTransform.TranslateX)): expected CompositeTransform.TranslateX, got ${JSON.stringify(q4)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty chained '(CompositeTransform.TranslateX)'): member on the second group's owner`);

  // (v) F12 on a framework member -> null (no source location — the documented metadata boundary).
  const q5 = await definitionWith(545, sb("(UIElement.Opac|ity)"), "sb-nav-f12-framework");
  if (q5 !== null)
    fail(`definition((UIElement.Opacity) framework member): expected null, got ${JSON.stringify(q5)}`);
  console.log(`[ok] definition(Storyboard.TargetProperty '(UIElement.Opacity)'): null (framework member, graceful)`);

  // (vi) an unresolvable owner in the group -> silent (never leaks a page/element member).
  const q6 = await hoverAt(546, sb("(NoSuchOwner.Fo|o)"), "sb-nav-unknown-owner");
  if (q6 !== "")
    fail(`hover((NoSuchOwner.Foo)): an unresolvable owner must be silent, got ${JSON.stringify(q6)}`);
  console.log(`[ok] hover(Storyboard.TargetProperty '(NoSuchOwner.Foo)'): silent — owner does not resolve`);


  // 20) semantic tokens — purely syntactic classification of NAMES by structural role (element type=class, attribute/member/attached=property, name prefix=namespace, markup-extension name=macro, named-arg=parameter). Values (the x:Name "Root", the resource key "Accent") and xmlns declarations are intentionally NOT tokenized. This buffer declares NO xmlns, so no prefix resolves and the defaultLibrary modifier never fires (a valid negative — the framework-vs-user marking is proven with a real header in case 426).
  const stLegend = ["namespace", "class", "property", "macro", "parameter"];
  const stBody = `<Grid x:Name="Root" Background="{StaticResource Accent}"><local:Foo Grid.Row="1" /></Grid>`;
  const stData = await semanticTokensWith(370, stBody, "mixed");
  const stToks = decodeSemanticTokens(stData, stBody.split("\n"), stLegend);
  for (const t of stToks) {
    if (t.modifiers !== 0) fail(`semanticTokens: no xmlns in scope, so no defaultLibrary modifier expected, got ${t.modifiers} on '${t.covered}'`);
  }
  const stHas = (covered, type) => stToks.some((t) => t.covered === covered && t.type === type);
  for (const [cov, ty] of [
    ["Grid", "class"], ["x", "namespace"], ["Name", "property"], ["Background", "property"],
    ["StaticResource", "macro"], ["local", "namespace"], ["Foo", "class"], ["Grid.Row", "property"],
  ]) {
    if (!stHas(cov, ty)) fail(`semanticTokens: expected a '${ty}' token covering '${cov}', got ${JSON.stringify(stToks)}`);
  }
  if (stToks.some((t) => t.covered === "Root")) fail(`semanticTokens: must not tokenize the x:Name value "Root", got ${JSON.stringify(stToks)}`);
  if (stToks.filter((t) => t.covered === "Grid" && t.type === "class").length !== 2)
    fail(`semanticTokens: expected 2 class tokens over Grid (open + end tag), got ${JSON.stringify(stToks)}`);
  console.log(`[ok] semantic tokens: element=class, prefix=namespace, member/attached=property, markup-ext=macro; values + xmlns skipped (${stData.length / 5} tokens)`);

  // 426) semantic-token defaultLibrary modifier — a name bound (via the document's OWN xmlns) to a framework
  // namespace (WinUI presentation or the XAML language ns) carries the modifier; a user-namespace name does not.
  const stModHeader = NS + ' xmlns:local="using:SmokeFixture"';
  const stModBody = `<Page ${stModHeader}><Grid x:Name="Root"><local:Foo Background="{StaticResource Accent}" /></Grid></Page>`;
  const stModData = await semanticTokensWith(426, stModBody, "modifiers");
  const stModToks = decodeSemanticTokens(stModData, stModBody.split("\n"), stLegend);
  const DEFAULT_LIBRARY = 1 << 0;
  const isFw = (covered, type) =>
    stModToks.some((t) => t.covered === covered && t.type === type && (t.modifiers & DEFAULT_LIBRARY) !== 0);
  const notFw = (covered) =>
    stModToks.filter((t) => t.covered === covered).every((t) => (t.modifiers & DEFAULT_LIBRARY) === 0);
  // Framework: default-ns element, Page, the x: directive prefix + local name, the unprefixed markup extension.
  for (const [cov, ty] of [["Page", "class"], ["Grid", "class"], ["x", "namespace"], ["Name", "property"], ["StaticResource", "macro"]]) {
    if (!isFw(cov, ty)) fail(`semanticTokens/modifiers: expected defaultLibrary on '${cov}' (${ty}), got ${JSON.stringify(stModToks)}`);
  }
  // User: the local: prefix + its element name; an UNPREFIXED member is never marked (its ns is its owner type).
  for (const cov of ["local", "Foo", "Background"]) {
    if (!notFw(cov)) fail(`semanticTokens/modifiers: '${cov}' must NOT carry defaultLibrary, got ${JSON.stringify(stModToks)}`);
  }
  console.log(`[ok] semantic tokens: defaultLibrary marks framework names (Grid/Page/x:Name/{StaticResource}) not user names (local:Foo, unprefixed member)`);

  // 427) semanticTokens/range — the same encoding limited to tokens overlapping the requested range. A request
  // for one line returns exactly that line's tokens; tokens on other lines are excluded.
  const stRangeBody = `<Grid>\n  <Button />\n  <TextBox />\n</Grid>`;
  const stRangeLines = stRangeBody.split("\n");
  const stFull = decodeSemanticTokens(await semanticTokensWith(427, stRangeBody, "range-full"), stRangeLines, stLegend);
  const stRange = decodeSemanticTokens(
    await semanticTokensRangeWith(428, stRangeBody, { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, "range-line1"),
    stRangeLines,
    stLegend
  );
  if (!stRange.some((t) => t.covered === "Button" && t.type === "class"))
    fail(`semanticTokens/range: expected the in-range Button token, got ${JSON.stringify(stRange)}`);
  if (stRange.some((t) => t.covered === "TextBox"))
    fail(`semanticTokens/range: TextBox is on line 2, out of the requested range, got ${JSON.stringify(stRange)}`);
  if (stRange.some((t) => t.covered === "Grid"))
    fail(`semanticTokens/range: Grid open/end tags are outside the requested range, got ${JSON.stringify(stRange)}`);
  // The ranged tokens must be exactly the full tokens on line 1 (identical absolute decoding, just a subset).
  const stFullLine1 = stFull.filter((t) => t.line === 1);
  if (JSON.stringify(stRange) !== JSON.stringify(stFullLine1))
    fail(`semanticTokens/range: expected the line-1 subset ${JSON.stringify(stFullLine1)}, got ${JSON.stringify(stRange)}`);
  console.log(`[ok] semantic tokens/range: line-1 request returns exactly Button (Grid + TextBox excluded), matching the full-set subset`);

  // 21) code actions ("Did you mean …?" quick fixes). The unknown-name diagnostics carry ranked spelling suggestions in Diagnostic.data (computed against the REAL SDK type list at diagnostic time); a textDocument/codeAction request turns each into a "Change 'X' to 'Y'" edit that replaces EXACTLY the flagged span with a known-valid name. Proves the full validator -> data -> code-action loop.
  const caDirty = xamlText.replace("<Button", "<Buton");
  if (caDirty === xamlText) fail("could not inject a misspelled element for the code-action case");
  const caDiags = await validateDoc(
    caDirty,
    (d) => d.some((x) => x.code === "WXAML0002" && x.message.includes("Buton")),
    "code-action unknown-type"
  );
  const caDiag = caDiags.find((x) => x.code === "WXAML0002" && x.message.includes("Buton"));
  if (!caDiag) fail(`code actions: expected a WXAML0002 for 'Buton' (got ${JSON.stringify(caDiags.map((x) => x.code))})`);
  // The validator must have attached ranked suggestions from the real SDK's type list.
  if (!caDiag.data || !Array.isArray(caDiag.data.suggestions) || !caDiag.data.suggestions.includes("Button")) {
    fail(`code actions: WXAML0002 for 'Buton' should carry a 'Button' suggestion in data (got ${JSON.stringify(caDiag.data)})`);
  }
  const caActions = await codeActionWith(380, caDiag, "buton-fix");
  const buttonFix = caActions.find((a) => a.title === "Change 'Buton' to 'Button'");
  if (!buttonFix) fail(`code actions: expected a "Change 'Buton' to 'Button'" quick fix (got ${JSON.stringify(caActions.map((a) => a.title))})`);
  if (buttonFix.kind !== "quickfix") fail(`code actions: fix kind should be 'quickfix', got ${buttonFix.kind}`);
  if (buttonFix.isPreferred !== true) fail(`code actions: the top suggestion should be isPreferred`);
  const caEdit = buttonFix.edit && buttonFix.edit.changes && buttonFix.edit.changes[xamlUri] && buttonFix.edit.changes[xamlUri][0];
  if (!caEdit || caEdit.newText !== "Button") fail(`code actions: fix must replace with 'Button' (got ${JSON.stringify(caEdit)})`);
  // The edit must cover EXACTLY the diagnostic's flagged span — never widen into markup.
  if (JSON.stringify(caEdit.range) !== JSON.stringify(caDiag.range)) {
    fail(`code actions: edit range ${JSON.stringify(caEdit.range)} must equal the diagnostic range ${JSON.stringify(caDiag.range)}`);
  }
  console.log(`[ok] code actions: <Buton> -> "Change 'Buton' to 'Button'" quickfix replacing exactly the flagged span (${caActions.length} action(s))`);

  // 21b) code action for a misspelled property element whose intended target is a GET-ONLY collection property (Grid.RowDefinitions has no setter). Regression guard: the suggestion candidate source must mirror property-element VALIDITY (HasProperty, get-only included), not the setter-only GetMembers — otherwise a real fix like RowDefinitionz -> RowDefinitions would be silently missing.
  const caPe = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <Grid.RowDefinitionz><RowDefinition /></Grid.RowDefinitionz>\n  </Grid>\n</Page>`;
  const caPeDiags = await validateDoc(
    caPe,
    (d) => d.some((x) => x.code === "WXAML0006" && x.message.includes("RowDefinitionz")),
    "code-action property-element member"
  );
  const caPeDiag = caPeDiags.find((x) => x.code === "WXAML0006" && x.message.includes("RowDefinitionz"));
  if (!caPeDiag) fail(`code actions: expected a WXAML0006 for 'RowDefinitionz' (got ${JSON.stringify(caPeDiags.map((x) => `${x.code}:${x.message}`))})`);
  if (!caPeDiag.data || !Array.isArray(caPeDiag.data.suggestions) || !caPeDiag.data.suggestions.includes("RowDefinitions")) {
    fail(`code actions: WXAML0006 for 'RowDefinitionz' should suggest the get-only 'RowDefinitions' (got ${JSON.stringify(caPeDiag.data)})`);
  }
  const caPeActions = await codeActionWith(382, caPeDiag, "rowdefz-fix");
  const caPeFix = caPeActions.find((a) => a.title === "Change 'RowDefinitionz' to 'RowDefinitions'");
  if (!caPeFix) fail(`code actions: expected a "Change 'RowDefinitionz' to 'RowDefinitions'" quick fix (got ${JSON.stringify(caPeActions.map((a) => a.title))})`);
  const caPeEdit = caPeFix.edit && caPeFix.edit.changes && caPeFix.edit.changes[xamlUri] && caPeFix.edit.changes[xamlUri][0];
  if (!caPeEdit || caPeEdit.newText !== "RowDefinitions") fail(`code actions: property-element fix must replace with 'RowDefinitions' (got ${JSON.stringify(caPeEdit)})`);
  if (JSON.stringify(caPeEdit.range) !== JSON.stringify(caPeDiag.range)) {
    fail(`code actions: property-element edit range ${JSON.stringify(caPeEdit.range)} must equal the diagnostic range ${JSON.stringify(caPeDiag.range)}`);
  }
  console.log(`[ok] code actions: <Grid.RowDefinitionz> -> "Change … to 'RowDefinitions'" (get-only collection property offered as a fix)`);

  // 21c) code action for a misspelled x:Bind PATH member (WXAML0005). VS offers a spelling fix for a mistyped bind member the same as any other unknown name. Two shapes exercised: a single-segment path (the diagnostic span IS the token) and a dotted path whose FIRST segment is wrong (the diagnostic underlines the WHOLE value, so the fix must narrow to just the bad segment and keep the trailing ".Length").
  const caBind = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind GreetingTexx}" />\n</Page>`;
  const caBindDiags = await validateDoc(
    caBind,
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx")),
    "code-action x:Bind member"
  );
  const caBindDiag = caBindDiags.find((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx"));
  if (!caBindDiag) fail(`code actions: expected a WXAML0005 for 'GreetingTexx' (got ${JSON.stringify(caBindDiags.map((x) => `${x.code}:${x.message}`))})`);
  if (!caBindDiag.data || !Array.isArray(caBindDiag.data.suggestions) || !caBindDiag.data.suggestions.includes("GreetingText")) {
    fail(`code actions: WXAML0005 for 'GreetingTexx' should suggest the bindable member 'GreetingText' (got ${JSON.stringify(caBindDiag.data)})`);
  }
  const caBindActions = await codeActionWith(384, caBindDiag, "bind-fix");
  const caBindFix = caBindActions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
  if (!caBindFix) fail(`code actions: expected a "Change 'GreetingTexx' to 'GreetingText'" quick fix (got ${JSON.stringify(caBindActions.map((a) => a.title))})`);
  const caBindEdit = caBindFix.edit && caBindFix.edit.changes && caBindFix.edit.changes[xamlUri] && caBindFix.edit.changes[xamlUri][0];
  if (!caBindEdit || caBindEdit.newText !== "GreetingText") fail(`code actions: x:Bind fix must replace with 'GreetingText' (got ${JSON.stringify(caBindEdit)})`);
  if (JSON.stringify(caBindEdit.range) !== JSON.stringify(caBindDiag.range)) {
    fail(`code actions: single-segment x:Bind edit range ${JSON.stringify(caBindEdit.range)} must equal the diagnostic range ${JSON.stringify(caBindDiag.range)}`);
  }
  console.log(`[ok] code actions: {x:Bind GreetingTexx} -> "Change … to 'GreetingText'" (bindable-member spelling fix)`);

  const caBind2 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <TextBlock Text="{x:Bind GreetingTexx.Length}" />\n</Page>`;
  const caBind2Diags = await validateDoc(
    caBind2,
    (d) => d.some((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx")),
    "code-action x:Bind dotted first segment"
  );
  const caBind2Diag = caBind2Diags.find((x) => x.code === "WXAML0005" && x.message.includes("GreetingTexx"));
  if (!caBind2Diag) fail(`code actions: expected a WXAML0005 for the dotted 'GreetingTexx.Length' (got ${JSON.stringify(caBind2Diags.map((x) => `${x.code}:${x.message}`))})`);
  const caBind2Actions = await codeActionWith(385, caBind2Diag, "bind-fix2");
  const caBind2Fix = caBind2Actions.find((a) => a.title === "Change 'GreetingTexx' to 'GreetingText'");
  if (!caBind2Fix) fail(`code actions: expected the dotted-path quick fix (got ${JSON.stringify(caBind2Actions.map((a) => a.title))})`);
  const caBind2Edit = caBind2Fix.edit && caBind2Fix.edit.changes && caBind2Fix.edit.changes[xamlUri] && caBind2Fix.edit.changes[xamlUri][0];
  if (!caBind2Edit || caBind2Edit.newText !== "GreetingText") fail(`code actions: dotted x:Bind fix must replace with 'GreetingText' (got ${JSON.stringify(caBind2Edit)})`);
  // The fix must NARROW to exactly "GreetingTexx" (12 chars) at the value start — NOT clobber the ".Length" tail.
  if (JSON.stringify(caBind2Edit.range.start) !== JSON.stringify(caBind2Diag.range.start)) {
    fail(`code actions: dotted x:Bind edit must start at the value start (got ${JSON.stringify(caBind2Edit.range.start)} vs diag ${JSON.stringify(caBind2Diag.range.start)})`);
  }
  if (caBind2Edit.range.end.character !== caBind2Diag.range.start.character + 12) {
    fail(`code actions: dotted x:Bind edit must cover exactly 'GreetingTexx' (12 chars), got end ${JSON.stringify(caBind2Edit.range.end)}`);
  }
  if (caBind2Edit.range.end.character >= caBind2Diag.range.end.character) {
    fail(`code actions: dotted x:Bind edit must be NARROWER than the whole-value diagnostic span so '.Length' survives (edit end ${caBind2Edit.range.end.character} >= diag end ${caBind2Diag.range.end.character})`);
  }
  console.log(`[ok] code actions: {x:Bind GreetingTexx.Length} -> fix narrows to 'GreetingTexx', preserving the '.Length' tail`);

  // 21d) code action for an undeclared WELL-KNOWN prefix (WXAML0001) -> "Add xmlns:d declaration". The fixture NS declares only the default + x namespaces, so a <d:Foo /> use leaves 'd' undeclared; the fix inserts the standard blend design-time namespace on the ROOT (grouped after the existing xmlns declarations) as a single zero-width edit, which makes the prefix resolvable.
  const caXmlns = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <d:Foo />\n  </Grid>\n</Page>`;
  const caXmlnsDiags = await validateDoc(
    caXmlns,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("d")),
    "code-action undeclared prefix"
  );
  const caXmlnsDiag = caXmlnsDiags.find((x) => x.code === "WXAML0001");
  if (!caXmlnsDiag) fail(`code actions: expected a WXAML0001 for the undeclared 'd' prefix (got ${JSON.stringify(caXmlnsDiags.map((x) => x.code))})`);
  const caXmlnsActions = await codeActionWith(392, caXmlnsDiag, "add-xmlns-d");
  const caXmlnsFix = caXmlnsActions.find((a) => a.title === "Add xmlns:d declaration");
  if (!caXmlnsFix) fail(`code actions: expected an "Add xmlns:d declaration" quick fix (got ${JSON.stringify(caXmlnsActions.map((a) => a.title))})`);
  if (caXmlnsFix.kind !== "quickfix") fail(`code actions: xmlns fix kind should be 'quickfix', got ${caXmlnsFix.kind}`);
  if (caXmlnsFix.isPreferred !== true) fail(`code actions: the xmlns fix should be isPreferred`);
  const caXmlnsEdit = caXmlnsFix.edit && caXmlnsFix.edit.changes && caXmlnsFix.edit.changes[xamlUri] && caXmlnsFix.edit.changes[xamlUri][0];
  const expectedXmlns = ' xmlns:d="http://schemas.microsoft.com/expression/blend/2008"';
  if (!caXmlnsEdit || caXmlnsEdit.newText !== expectedXmlns) {
    fail(`code actions: xmlns fix must insert '${expectedXmlns}' (got ${JSON.stringify(caXmlnsEdit)})`);
  }
  // A pure insertion: zero-width range on the root's open-tag line.
  if (JSON.stringify(caXmlnsEdit.range.start) !== JSON.stringify(caXmlnsEdit.range.end)) {
    fail(`code actions: xmlns fix must be a zero-width insertion (got ${JSON.stringify(caXmlnsEdit.range)})`);
  }
  if (caXmlnsEdit.range.start.line !== 0) {
    fail(`code actions: xmlns fix must insert on the root open-tag line 0 (got line ${caXmlnsEdit.range.start.line})`);
  }
  console.log(`[ok] code actions: <d:Foo /> undeclared prefix -> "Add xmlns:d declaration" (zero-width insertion of the standard blend namespace)`);

  // 21e) code action for an undeclared CUSTOM prefix (WXAML0001) whose element names one of the project's OWN source types -> "Add xmlns:local=\"using:<namespace>\"". <local:SmokePage> references the fixture's own SmokeFixture.SmokePage, so the fix INFERS the using: namespace from the type system (grouped after the root's xmlns declarations, before x:Class) as a single zero-width edit.
  const caUsing = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <local:SmokePage />\n  </Grid>\n</Page>`;
  const caUsingDiags = await validateDoc(
    caUsing,
    (d) => d.some((x) => x.code === "WXAML0001" && x.message.includes("'local'")),
    "code-action custom prefix using:"
  );
  const caUsingDiag = caUsingDiags.find((x) => x.code === "WXAML0001");
  if (!caUsingDiag) fail(`code actions: expected a WXAML0001 for the undeclared 'local' prefix (got ${JSON.stringify(caUsingDiags.map((x) => x.code))})`);
  const caUsingActions = await codeActionWith(393, caUsingDiag, "add-xmlns-local-using");
  const caUsingFix = caUsingActions.find((a) => a.title === 'Add xmlns:local="using:SmokeFixture"');
  if (!caUsingFix) fail(`code actions: expected an 'Add xmlns:local="using:SmokeFixture"' quick fix (got ${JSON.stringify(caUsingActions.map((a) => a.title))})`);
  if (caUsingFix.kind !== "quickfix") fail(`code actions: using: fix kind should be 'quickfix', got ${caUsingFix.kind}`);
  if (caUsingFix.isPreferred !== true) fail(`code actions: the using: fix should be isPreferred (single candidate namespace)`);
  const caUsingEdit = caUsingFix.edit && caUsingFix.edit.changes && caUsingFix.edit.changes[xamlUri] && caUsingFix.edit.changes[xamlUri][0];
  const expectedUsing = ' xmlns:local="using:SmokeFixture"';
  if (!caUsingEdit || caUsingEdit.newText !== expectedUsing) {
    fail(`code actions: using: fix must insert '${expectedUsing}' (got ${JSON.stringify(caUsingEdit)})`);
  }
  if (JSON.stringify(caUsingEdit.range.start) !== JSON.stringify(caUsingEdit.range.end)) {
    fail(`code actions: using: fix must be a zero-width insertion (got ${JSON.stringify(caUsingEdit.range)})`);
  }
  if (caUsingEdit.range.start.line !== 0) {
    fail(`code actions: using: fix must insert on the root open-tag line 0 (got line ${caUsingEdit.range.start.line})`);
  }
  // Grouped after the xmlns block but before x:Class (proves the insertion point, and that applying it
  // yields a well-formed root declaration that makes 'local' resolvable).
  {
    const rootLine0 = caUsing.split("\n")[0];
    const spliced = rootLine0.slice(0, caUsingEdit.range.start.character) + expectedUsing + rootLine0.slice(caUsingEdit.range.start.character);
    const locAt = spliced.indexOf('xmlns:local="using:SmokeFixture"');
    if (locAt < 0 || !(spliced.indexOf("xmlns:x") < locAt && locAt < spliced.indexOf("x:Class"))) {
      fail(`code actions: using: fix must be grouped after the xmlns block and before x:Class (spliced: ${spliced})`);
    }
  }
  console.log(`[ok] code actions: <local:SmokePage> undeclared custom prefix -> 'Add xmlns:local="using:SmokeFixture"' (using: namespace inferred from the project's own type)`);

  // 22a) close-tag completion — typing "</" inside an unclosed element offers that element's name so it completes to "</Grid>" (VS-style). Purely AST-driven (no type system): the nearest UNCLOSED enclosing element wins; a '>' is appended only when one is not already present after the caret; self-closed siblings are skipped; property-element (dotted) names come whole; and when every enclosing element is already closed nothing is offered (never a name that wouldn't balance).
  const ctBody = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </|\n</Page>`;
  const ctItems = await completeItemsWith(386, ctBody, "close-tag unclosed grid");
  const ctGrid = ctItems.find((i) => i.label === "Grid");
  if (!ctGrid) fail(`close-tag: '</' inside an unclosed <Grid> should offer 'Grid' (got ${JSON.stringify(ctItems.map((i) => i.label))})`);
  if (!ctGrid.textEdit || ctGrid.textEdit.newText !== "Grid>") {
    fail(`close-tag: no '>' after the caret means the fix must append it -> 'Grid>' (got ${JSON.stringify(ctGrid.textEdit)})`);
  }
  console.log(`[ok] close-tag: '</' in an unclosed <Grid> -> 'Grid>' (${ctItems.length} item)`);

  // '<' auto-closing pair leaves "</>" with the caret before the '>': reuse it, don't double it.
  const ctBody2 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </|>\n</Page>`;
  const ctItems2 = await completeItemsWith(387, ctBody2, "close-tag autoclosed bracket");
  const ctGrid2 = ctItems2.find((i) => i.label === "Grid");
  if (!ctGrid2) fail(`close-tag: '</>' inside an unclosed <Grid> should still offer 'Grid' (got ${JSON.stringify(ctItems2.map((i) => i.label))})`);
  if (!ctGrid2.textEdit || ctGrid2.textEdit.newText !== "Grid") {
    fail(`close-tag: an existing '>' after the caret must be reused -> 'Grid' with no extra bracket (got ${JSON.stringify(ctGrid2.textEdit)})`);
  }
  console.log(`[ok] close-tag: '</>' (auto-closed bracket) -> 'Grid' reusing the existing '>'`);

  // Property-element (dotted) name comes whole; self-closed siblings are skipped.
  const ctBody3 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n      </|\n  </Grid>\n</Page>`;
  const ctLabels3 = (await completeItemsWith(388, ctBody3, "close-tag property element")).map((i) => i.label);
  if (!ctLabels3.includes("Grid.RowDefinitions")) {
    fail(`close-tag: '</' inside <Grid.RowDefinitions> should offer the whole dotted name (got ${JSON.stringify(ctLabels3)})`);
  }
  console.log(`[ok] close-tag: '</' inside <Grid.RowDefinitions> -> 'Grid.RowDefinitions' (self-closed <RowDefinition/> skipped)`);

  // When every enclosing element is already closed, nothing is offered (no guessed name).
  const ctBody4 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <StackPanel></StackPanel>\n  </|\n</Page>`;
  const ctLabels4 = (await completeItemsWith(389, ctBody4, "close-tag all closed")).map((i) => i.label);
  if (ctLabels4.length !== 0) {
    fail(`close-tag: with every enclosing element already closed, nothing should be offered (got ${JSON.stringify(ctLabels4)})`);
  }
  console.log(`[ok] close-tag: all enclosing elements closed -> no suggestion (never guesses an unbalancing name)`);

  // Fully-typed matching name WITHOUT '>': the parser marks the element closed (EndTagSpan present)
  // yet the tag still needs its '>', so the suggestion must stay available through the last keystroke
  // and append '>'. (round-47 red-team regression: previously returned nothing.)
  const ctBody5 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </Grid|\n</Page>`;
  const ctItems5 = await completeItemsWith(390, ctBody5, "close-tag fully-typed no bracket");
  const ctGrid5 = ctItems5.find((i) => i.label === "Grid");
  if (!ctGrid5) fail(`close-tag: a fully-typed '</Grid' must still offer 'Grid' (got ${JSON.stringify(ctItems5.map((i) => i.label))})`);
  if (!ctGrid5.textEdit || ctGrid5.textEdit.newText !== "Grid>") {
    fail(`close-tag: fully-typed '</Grid' with no '>' must append it -> 'Grid>' (got ${JSON.stringify(ctGrid5.textEdit)})`);
  }
  console.log(`[ok] close-tag: fully-typed '</Grid' (no '>') -> 'Grid>' (stays available, appends '>')`);

  // Fully-typed matching name WITH '>' already present (caret before it): still offered, reuse the '>'.
  const ctBody6 = `<Page ${NS} x:Class="SmokeFixture.SmokePage">\n  <Grid>\n    </Grid|>\n</Page>`;
  const ctItems6 = await completeItemsWith(391, ctBody6, "close-tag fully-typed with bracket");
  const ctGrid6 = ctItems6.find((i) => i.label === "Grid");
  if (!ctGrid6) fail(`close-tag: a fully-typed '</Grid>' (caret before '>') must still offer 'Grid' (got ${JSON.stringify(ctItems6.map((i) => i.label))})`);
  if (!ctGrid6.textEdit || ctGrid6.textEdit.newText !== "Grid") {
    fail(`close-tag: fully-typed '</Grid>' must reuse the existing '>' -> 'Grid' (got ${JSON.stringify(ctGrid6.textEdit)})`);
  }
  console.log(`[ok] close-tag: fully-typed '</Grid>' (caret before '>') -> 'Grid' reusing the existing '>'`);

  // 21f) xmlns "using:" CLR-namespace completion — offers the project's OWN source namespaces (SmokeFixture, sort group 0 / detail "CLR namespace") AND the referenced-assembly namespaces (framework + libraries, sort group 1 / detail "CLR namespace (referenced)"), so a control library reached only through using: is completable (VS parity). The two groups are disjoint. Also a PERF gate: the referenced walk over the full WinAppSDK reference closure runs on this first call (then caches).
  const unBody = `<Page ${NS} xmlns:local="using:|">\n  <Grid />\n</Page>`;
  const unStart = Date.now();
  const unItems = await completeItemsWith(394, unBody, "using-namespace");
  const unElapsed = Date.now() - unStart;
  const unSource = unItems.filter((i) => i.detail === "CLR namespace").map((i) => i.label);
  const unReferenced = unItems.filter((i) => i.detail === "CLR namespace (referenced)").map((i) => i.label);
  if (!unSource.includes("SmokeFixture")) {
    fail(`using: completion must offer the project namespace 'SmokeFixture' as a source namespace (got source ${JSON.stringify(unSource)})`);
  }
  // The referenced group now DOES include framework/library namespaces (a library referenced as an assembly with
  // no registered xmlns is reachable ONLY via using:). "Microsoft.UI.Xaml.Controls" sorts early (Ordinal 'M'), so
  // it survives the MaxItems truncation of the large closure.
  if (!unReferenced.includes("Microsoft.UI.Xaml.Controls")) {
    fail(`using: completion must offer referenced framework namespaces (expected 'Microsoft.UI.Xaml.Controls' in the referenced group; got ${unReferenced.length} referenced items)`);
  }
  // The two groups are disjoint: a source namespace is never also referenced, and vice versa.
  if (unReferenced.includes("SmokeFixture")) {
    fail(`'SmokeFixture' is a source namespace and must not also appear in the referenced group`);
  }
  if (unSource.includes("Microsoft.UI.Xaml.Controls")) {
    fail(`'Microsoft.UI.Xaml.Controls' is a referenced namespace and must not appear in the source group`);
  }
  if (unElapsed > 15000) {
    fail(`using: completion (first referenced-closure walk) took ${unElapsed}ms — perf gate exceeded`);
  }
  console.log(`[ok] using: completion -> source 'SmokeFixture' + ${unReferenced.length} referenced framework/library namespaces (first-call ${unElapsed}ms)`);

  const unBodyMatch = `<Page ${NS} xmlns:local="using:Smoke|">\n  <Grid />\n</Page>`;
  const unLabelsMatch = await completeWith(395, unBodyMatch, "using-namespace-filter");
  if (!unLabelsMatch.includes("SmokeFixture")) {
    fail(`using:Smoke should still match 'SmokeFixture' on the dotted prefix (got ${JSON.stringify(unLabelsMatch)})`);
  }
  const unBodyMiss = `<Page ${NS} xmlns:local="using:Zzz|">\n  <Grid />\n</Page>`;
  const unLabelsMiss = await completeWith(396, unBodyMiss, "using-namespace-filter-miss");
  if (unLabelsMiss.includes("SmokeFixture")) {
    fail(`using:Zzz must NOT match 'SmokeFixture' (got ${JSON.stringify(unLabelsMiss)})`);
  }
  console.log(`[ok] using: completion filters on the whole dotted token (Smoke -> match, Zzz -> no match)`);

  // 429) Referenced-namespace dotted-prefix filtering — typing a partial dotted referenced namespace filters the
  //      referenced group on the WHOLE token, and the token-only replacement never corrupts the typed prefix.
  const unRefBody = `<Page ${NS} xmlns:zzz="using:Microsoft.UI.Xaml.Cont|">\n  <Grid />\n</Page>`;
  const unRefItems = await completeItemsWith(429, unRefBody, "using-referenced-filter");
  const unRefCtrls = unRefItems.find((i) => i.label === "Microsoft.UI.Xaml.Controls");
  if (!unRefCtrls || unRefCtrls.detail !== "CLR namespace (referenced)") {
    fail(`using: dotted referenced filter must offer 'Microsoft.UI.Xaml.Controls' (referenced); got ${JSON.stringify(unRefItems.map((i) => i.label))}`);
  }
  if (unRefCtrls.textEdit && unRefCtrls.textEdit.newText !== "Microsoft.UI.Xaml.Controls") {
    fail(`using: referenced completion must replace with the whole namespace token (got ${JSON.stringify(unRefCtrls.textEdit)})`);
  }
  console.log(`[ok] using: referenced completion filters on the whole dotted token -> Microsoft.UI.Xaml.Controls`);

  Object.assign(ctx, { colors, swatch, near });
}
