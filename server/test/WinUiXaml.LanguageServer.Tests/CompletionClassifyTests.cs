using Xunit;

namespace WinUiXaml.LanguageServer.Tests;

/// <summary>
/// Hermetic coverage for the caret-context text scanner in <see cref="CompletionProvider"/>. These
/// lock two red-team regressions without a Roslyn compilation: XML-comment suppression and the
/// x:Bind <c>Path=</c> named argument. The <c>|</c> marker in each input is the caret.
/// </summary>
public class CompletionClassifyTests
{
    private static string Classify(string textWithCaret)
    {
        int offset = textWithCaret.IndexOf('|');
        Assert.True(offset >= 0, "test input must contain a '|' caret marker");
        var text = textWithCaret.Remove(offset, 1);
        return CompletionProvider.ClassifyForTest(text, offset);
    }

    // --- XML comment suppression (defect 1) -------------------------------------------------------

    [Fact]
    public void ElementCompletionInsideComment_IsSuppressed()
    {
        Assert.Equal("None", Classify("<Grid>\n  <!-- <But| -->\n</Grid>"));
    }

    [Fact]
    public void ElementCompletionInsideMultilineComment_IsSuppressed()
    {
        Assert.Equal("None", Classify("<!--\n  <But|\n-->"));
    }

    [Fact]
    public void ElementCompletionAfterClosedComment_StillClassifies()
    {
        Assert.Equal("ElementName:But", Classify("<!-- old --> <But|"));
    }

    [Fact]
    public void ElementCompletionOutsideAnyComment_StillClassifies()
    {
        Assert.Equal("ElementName:But", Classify("<Grid>\n  <But|\n</Grid>"));
    }

    // --- CDATA suppression (defect: CDATA leak) ---------------------------------------------------

    [Fact]
    public void ElementCompletionInsideCData_IsSuppressed()
    {
        Assert.Equal("None", Classify("<Grid>\n  <![CDATA[ <But| ]]>\n</Grid>"));
    }

    [Fact]
    public void ElementCompletionAfterClosedCData_StillClassifies()
    {
        Assert.Equal("ElementName:But", Classify("<Grid><![CDATA[ x ]]> <But|"));
    }

    // --- Nested markup extensions (defect: nested resource completion) -----------------------------

    [Fact]
    public void NestedStaticResourceKey_ClassifiesAsResourceKey()
    {
        Assert.Equal("ResourceKey:", Classify("<Border Tag=\"{Binding Source={StaticResource |}}\" />"));
    }

    [Fact]
    public void NestedStaticResourceKey_WithPartial_CarriesPartial()
    {
        Assert.Equal("ResourceKey:Accent", Classify("<Border Tag=\"{Binding Source={StaticResource Accent|}}\" />"));
    }

    [Fact]
    public void NonNestedStaticResourceKey_StillClassifiesAsResourceKey()
    {
        Assert.Equal("ResourceKey:Accent", Classify("<Grid Background=\"{StaticResource Accent|}\" />"));
    }

    [Fact]
    public void NestedBindPath_ClassifiesAsBindPath()
    {
        Assert.Equal("BindPath:|Gre", Classify("<TextBlock Text=\"{Binding Converter={x:Bind Gre|}}\" />"));
    }

    // --- x:Bind Path= named argument (defect 2) ---------------------------------------------------

    [Fact]
    public void BindNamedPath_ClassifiesAsBindPath()
    {
        Assert.Equal("BindPath:|Gre", Classify("<TextBlock Text=\"{x:Bind Path=Gre|}\" />"));
    }

    [Fact]
    public void BindNamedPath_WithWhitespaceAroundEquals_ClassifiesAsBindPath()
    {
        Assert.Equal("BindPath:|Gre", Classify("<TextBlock Text=\"{x:Bind Path = Gre|}\" />"));
    }

    [Fact]
    public void BindNamedPath_Dotted_CarriesPrefixPath()
    {
        Assert.Equal("BindPath:Items|Co", Classify("<TextBlock Text=\"{x:Bind Path=Items.Co|}\" />"));
    }

    [Fact]
    public void BindPositionalPath_StillClassifiesAsBindPath()
    {
        Assert.Equal("BindPath:|Gre", Classify("<TextBlock Text=\"{x:Bind Gre|}\" />"));
    }

    [Fact]
    public void BindPositionalDottedPath_StillCarriesPrefixPath()
    {
        Assert.Equal("BindPath:Items|Co", Classify("<TextBlock Text=\"{x:Bind Items.Co|}\" />"));
    }

    // --- Cast x:Bind path ((local:Type)Member) rebinds the completion root --------------------------

    [Fact]
    public void BindCastPath_CarriesCastTypeAndCompletesMemberAfterParen()
    {
        Assert.Equal("BindPath:(local:SmokePage)|Gre", Classify("<TextBlock Text=\"{x:Bind (local:SmokePage)Gre|}\" />"));
    }

    [Fact]
    public void BindCastPath_Dotted_CarriesCastTypeAndPrefixPath()
    {
        Assert.Equal("BindPath:(local:SmokePage)Items|Co", Classify("<TextBlock Text=\"{x:Bind (local:SmokePage)Items.Co|}\" />"));
    }

    [Fact]
    public void BindCastPath_CaretInsideCastParens_IsNotBindPath()
    {
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{x:Bind (local:Smoke|)}\" />"));
    }

    [Fact]
    public void BindAttachedPath_IsNotCompletedAsBindPath()
    {
        // (Owner.Member) is an attached-property step, resolved by hover, not member completion.
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{x:Bind (Grid.Ro|w)}\" />"));
    }

    // --- Path= must not hijack other named arguments (regression guard) ---------------------------

    [Fact]
    public void BindModeArgument_IsNotClassifiedAsBindPath()
    {
        var result = Classify("<TextBlock Text=\"{x:Bind GreetingText, Mode=|}\" />");
        Assert.DoesNotContain("BindPath", result);
    }

    [Fact]
    public void BindConverterArgumentAfterPositionalPath_IsNotBindPath()
    {
        var result = Classify("<TextBlock Text=\"{x:Bind GreetingText, Converter=Con|}\" />");
        Assert.DoesNotContain("BindPath", result);
    }

    // --- Unquoted attribute value (defect: IsEnabled=| offered attribute names) --------------------

    [Fact]
    public void UnquotedValueRightAfterEquals_ClassifiesAsAttributeValue()
    {
        Assert.Equal("AttributeValue:IsEnabled:", Classify("<Button IsEnabled=| />"));
    }

    [Fact]
    public void UnquotedValuePartial_CarriesAttributeNameAndPartial()
    {
        Assert.Equal("AttributeValue:IsEnabled:Tr", Classify("<Button IsEnabled=Tr| />"));
    }

    [Fact]
    public void UnquotedValueWithWhitespaceAfterEquals_ClassifiesAsAttributeValue()
    {
        Assert.Equal("AttributeValue:IsEnabled:", Classify("<Button IsEnabled = | />"));
    }

    [Fact]
    public void QuotedValue_StillClassifiesAsAttributeValue()
    {
        Assert.Equal("AttributeValue:IsEnabled:", Classify("<Button IsEnabled=\"|\" />"));
    }

    [Fact]
    public void AttributeNamePosition_IsNotHijackedByUnquotedValue()
    {
        Assert.Equal("AttributeName:IsEna", Classify("<Button IsEna| />"));
    }

    [Fact]
    public void NewlineInsideStartTag_ClassifiesAsEmptyAttributeName()
    {
        Assert.Equal("AttributeName:", Classify("<Button\n    | />"));
    }

    // --- {x:Type} / {x:Static} references (round 20) ----------------------------------------------

    [Fact]
    public void XTypeArgument_ClassifiesAsTypeName()
    {
        Assert.Equal("TypeName:Butt", Classify("<Button Tag=\"{x:Type Butt|}\" />"));
    }

    [Fact]
    public void XTypeArgument_Prefixed_CarriesPrefix()
    {
        Assert.Equal("TypeName:local:Smoke", Classify("<Button Tag=\"{x:Type local:Smoke|}\" />"));
    }

    [Fact]
    public void XStaticArgument_BeforeDot_ClassifiesAsTypeName()
    {
        Assert.Equal("TypeName:Visi", Classify("<Button Tag=\"{x:Static Visi|}\" />"));
    }

    [Fact]
    public void XStaticArgument_AfterDot_ClassifiesAsStaticMemberWithOwner()
    {
        Assert.Equal("StaticMember:Visibility:Coll", Classify("<Button Tag=\"{x:Static Visibility.Coll|}\" />"));
    }

    [Fact]
    public void XStaticArgument_AfterDotEmpty_ClassifiesAsStaticMember()
    {
        Assert.Equal("StaticMember:Visibility:", Classify("<Button Tag=\"{x:Static Visibility.|}\" />"));
    }

    [Fact]
    public void XStaticArgument_Prefixed_CarriesPrefixedOwner()
    {
        Assert.Equal("StaticMember:local:Colors:Acc", Classify("<Button Tag=\"{x:Static local:Colors.Acc|}\" />"));
    }

    [Fact]
    public void XTypeName_StillTyping_ClassifiesAsMarkupName()
    {
        Assert.Equal("MarkupName:x:Ty", Classify("<Button Tag=\"{x:Ty|}\" />"));
    }

    [Fact]
    public void XTypeArgument_AfterWhitespace_EndsToken()
    {
        // A space after the type name means the argument token has ended -> not a TypeName context.
        Assert.DoesNotContain("TypeName", Classify("<Button Tag=\"{x:Type Button |}\" />"));
    }

    // --- Close-tag completion context -------------------------------------------------------------

    [Fact]
    public void EndTag_JustAfterSlash_ClassifiesAsCloseTagWithEmptyPartial()
    {
        Assert.Equal("CloseTag:", Classify("<Grid>\n  </|"));
    }

    [Fact]
    public void EndTag_PartialName_CarriesPartial()
    {
        Assert.Equal("CloseTag:Gr", Classify("<Grid>\n  </Gr|"));
    }

    [Fact]
    public void EndTag_BeforeAutoClosedBracket_ClassifiesAsCloseTag()
    {
        // VS Code's '<' auto-closing pair leaves "</>" with the caret before the '>'.
        Assert.Equal("CloseTag:", Classify("<Grid>\n  </|>"));
    }

    [Fact]
    public void EndTag_DottedPropertyElementName_IsWholeToken()
    {
        Assert.Equal("CloseTag:Grid.RowDefinitions", Classify("<Grid.RowDefinitions>\n  </Grid.RowDefinitions|"));
    }

    [Fact]
    public void EndTag_PrefixedName_IsWholeToken()
    {
        Assert.Equal("CloseTag:local:Foo", Classify("<local:Foo>\n  </local:Foo|"));
    }

    [Fact]
    public void EndTag_CaretBetweenAngleAndSlash_IsNone()
    {
        Assert.Equal("None", Classify("<Grid>\n  <|/Grid>"));
    }

    [Fact]
    public void EndTag_PastNameOnWhitespace_IsNone()
    {
        Assert.Equal("None", Classify("<Grid>\n  </Grid |"));
    }

    [Fact]
    public void EndTag_InsideComment_IsSuppressed()
    {
        Assert.Equal("None", Classify("<Grid>\n  <!-- </Gr| -->\n</Grid>"));
    }

    [Fact]
    public void CommentStart_IsNotCloseTag()
    {
        Assert.Equal("None", Classify("<Grid>\n  <!|"));
    }

    // --- Close-tag TARGET RESOLUTION (CompleteCloseTag, round-47 red-team regressions) -------------
    // These exercise the emitted item ("label=>newText") without a Roslyn compilation, since the
    // close-tag path is resolved purely from the parsed AST.

    private static IReadOnlyList<string> CloseTagItems(string textWithCaret)
    {
        int offset = textWithCaret.IndexOf('|');
        Assert.True(offset >= 0, "test input must contain a '|' caret marker");
        var text = textWithCaret.Remove(offset, 1);
        return CompletionProvider.CloseTagItemsForTest(text, offset);
    }

    [Fact]
    public void CloseTag_EmptyPartial_OffersInnermostUnclosed()
    {
        Assert.Equal(new[] { "Grid=>Grid>" }, CloseTagItems("<Grid>\n  </|"));
    }

    [Fact]
    public void CloseTag_PartialName_OffersFullName()
    {
        Assert.Equal(new[] { "Grid=>Grid>" }, CloseTagItems("<Grid>\n  </Gr|"));
    }

    [Fact]
    public void CloseTag_FullyTypedName_NoBracket_StillOffersAndAppendsBracket()
    {
        // Regression: once the typed name matches, the parser marks the element closed with an
        // EndTagSpan even without the '>'. The completion must stay available and append '>'.
        Assert.Equal(new[] { "Grid=>Grid>" }, CloseTagItems("<Grid>\n  </Grid|"));
    }

    [Fact]
    public void CloseTag_FullyTypedName_WithBracket_ReusesExistingBracket()
    {
        // Regression: caret before an already-present '>' on a fully-typed matching name — still
        // offered, and reuses the '>' rather than producing "Grid>>".
        Assert.Equal(new[] { "Grid=>Grid" }, CloseTagItems("<Grid>\n  </Grid|>"));
    }

    [Fact]
    public void CloseTag_AutoClosedEmpty_ReusesExistingBracket()
    {
        Assert.Equal(new[] { "Grid=>Grid" }, CloseTagItems("<Grid>\n  </|>"));
    }

    [Fact]
    public void CloseTag_FullyTypedInner_PrefersInnerOverUnclosedOuter()
    {
        // The '</Grid' closes the inner Grid even though <Outer> is still unclosed and also encloses
        // the caret — the end tag beginning at this '<' pins the target.
        Assert.Equal(new[] { "Grid=>Grid>" }, CloseTagItems("<Outer><Grid>\n  </Grid|"));
    }

    [Fact]
    public void CloseTag_PropertyElement_OffersDottedName()
    {
        Assert.Equal(
            new[] { "Grid.RowDefinitions=>Grid.RowDefinitions>" },
            CloseTagItems("<Grid>\n  <Grid.RowDefinitions>\n    <RowDefinition />\n    </|\n  </Grid>"));
    }

    [Fact]
    public void CloseTag_AllEnclosingClosed_OffersNothing()
    {
        Assert.Empty(CloseTagItems("<Grid>\n  <Button />\n  </Grid>\n  </|"));
    }

    // --- xmlns "using:" CLR-namespace completion (round 50) ---------------------------------------

    [Fact]
    public void UsingNamespace_RightAfterScheme_ClassifiesWithEmptyPartial()
    {
        Assert.Equal("UsingNamespace:", Classify("<Page xmlns:local=\"using:|\">"));
    }

    [Fact]
    public void UsingNamespace_Partial_CarriesPartial()
    {
        Assert.Equal("UsingNamespace:Smoke", Classify("<Page xmlns:local=\"using:Smoke|\">"));
    }

    [Fact]
    public void UsingNamespace_DottedPartial_KeepsWholeDottedToken()
    {
        // The replace/filter span is the whole dotted namespace, so the partial keeps the leading segments.
        Assert.Equal("UsingNamespace:Foo.Bar", Classify("<Page xmlns:local=\"using:Foo.Bar|\">"));
    }

    [Fact]
    public void UsingNamespace_DefaultXmlns_AlsoClassifies()
    {
        Assert.Equal("UsingNamespace:My", Classify("<Page xmlns=\"using:My|\">"));
    }

    [Fact]
    public void UsingNamespace_SchemeStillTyping_ClassifiesAsXmlnsValue()
    {
        // Until the full "using:" scheme is typed the using: NAMESPACE classifier declines; round 61 now
        // classifies this as an xmlns VALUE so the using: scheme item (and the framework URIs) are offered.
        Assert.Equal("XmlnsValue:using", Classify("<Page xmlns:local=\"using|\">"));
    }

    [Fact]
    public void UsingNamespace_NonXmlnsAttribute_IsNotUsingNamespace()
    {
        // A using:-looking value on a NON-xmlns attribute is just an attribute value, never a namespace.
        Assert.Equal("AttributeValue:Tag:using:Foo", Classify("<Page Tag=\"using:Foo|\">"));
    }

    // --- xmlns declaration VALUE completion: framework URIs + using: scheme (round 61) ----------------

    [Fact]
    public void XmlnsValue_EmptyValue_ClassifiesWithEmptyPartial()
    {
        Assert.Equal("XmlnsValue:", Classify("<Page xmlns:local=\"|\">"));
    }

    [Fact]
    public void XmlnsValue_PartialUri_CarriesPartial()
    {
        Assert.Equal("XmlnsValue:http", Classify("<Page xmlns:local=\"http|\">"));
    }

    [Fact]
    public void XmlnsValue_DefaultXmlns_AlsoClassifies()
    {
        Assert.Equal("XmlnsValue:", Classify("<Page xmlns=\"|\">"));
    }

    [Fact]
    public void XmlnsValue_NonXmlnsAttribute_IsOrdinaryAttributeValue()
    {
        // An empty value on a NON-xmlns attribute is a normal attribute value, never an xmlns value.
        Assert.Equal("AttributeValue:Tag:", Classify("<Page Tag=\"|\">"));
    }

    // --- RelativePanel alignment attached-property x:Name completion (round 62) --------------------

    [Fact]
    public void AttachedProperty_DottedName_IsCapturedWholeForAttributeValue()
    {
        // The RelativePanel.RightOf branch keys on the WHOLE dotted attached-property name, so the
        // classifier must surface it intact (owner + member) as the AttributeValue name.
        Assert.Equal("AttributeValue:RelativePanel.RightOf:", Classify("<Button RelativePanel.RightOf=\"|\" />"));
    }

    // --- classic {Binding} member-path completion (round 51) --------------------------------------

    [Fact]
    public void ClassicBinding_PositionalPath_ClassifiesAsClassicBindPath()
    {
        Assert.Equal("ClassicBindPath:|Gre", Classify("<TextBlock Text=\"{Binding Gre|}\" />"));
    }

    [Fact]
    public void ClassicBinding_NamedPath_ClassifiesAsClassicBindPath()
    {
        Assert.Equal("ClassicBindPath:|Gre", Classify("<TextBlock Text=\"{Binding Path=Gre|}\" />"));
    }

    [Fact]
    public void ClassicBinding_EmptyPositional_ClassifiesWithEmptyPartial()
    {
        Assert.Equal("ClassicBindPath:|", Classify("<TextBlock Text=\"{Binding |}\" />"));
    }

    [Fact]
    public void ClassicBinding_DottedPath_CarriesPrefixPath()
    {
        Assert.Equal("ClassicBindPath:Items|Co", Classify("<TextBlock Text=\"{Binding Items.Co|}\" />"));
    }

    [Fact]
    public void ClassicBinding_IsDistinctFromCompiledBind()
    {
        // x:Bind stays plain BindPath (rooted at x:Class); only {Binding} carries the classic marker.
        Assert.Equal("BindPath:|Gre", Classify("<TextBlock Text=\"{x:Bind Gre|}\" />"));
    }

    [Fact]
    public void ClassicBinding_WithElementName_RootsAtNamedElement()
    {
        // ElementName repoints the source to a named element, so the path completes against THAT element's
        // type (round 76). The element name is annotated so CompleteBindPath resolves the right root.
        Assert.Equal("ClassicBindPath@Foo:|Ba", Classify("<TextBlock Text=\"{Binding ElementName=Foo, Path=Ba|}\" />"));
    }

    [Fact]
    public void ClassicBinding_WithSourceRedirect_IsNotBindPath()
    {
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{Binding Source={StaticResource X}, Path=Ba|}\" />"));
    }

    [Fact]
    public void ClassicBinding_WithRelativeSourceRedirect_IsNotBindPath()
    {
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{Binding RelativeSource={RelativeSource TemplatedParent}, Path=Ba|}\" />"));
    }

    [Fact]
    public void ClassicBinding_ElementNameAfterCaret_RootsAtNamedElement()
    {
        // The whole extension is scanned, so an ElementName following the caret still roots the positional
        // path at that named element (round 76).
        Assert.Equal("ClassicBindPath@Foo:|Ba", Classify("<TextBlock Text=\"{Binding Ba|, ElementName=Foo}\" />"));
    }

    [Fact]
    public void ClassicBinding_ElementNameEmptyPath_RootsAtNamedElement()
    {
        // The common completion shape {Binding ElementName=Foo, Path=|} roots the empty path at the element.
        Assert.Equal("ClassicBindPath@Foo:|", Classify("<TextBlock Text=\"{Binding ElementName=Foo, Path=|}\" />"));
    }

    [Fact]
    public void ClassicBinding_MemberNamedSource_IsStillBindPath()
    {
        // "Source" here is a PATH value (Path=Source), not a Source= argument, so completion proceeds.
        Assert.Equal("ClassicBindPath:|Sou", Classify("<TextBlock Text=\"{Binding Path=Sou|}\" />"));
    }

    [Fact]
    public void ClassicBinding_ModeArgument_IsNotBindPath()
    {
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{Binding GreetingText, Mode=|}\" />"));
    }

    [Fact]
    public void ClassicBinding_BarePositionalNamedLikeRedirector_IsStillBindPath()
    {
        // A bare positional first argument is ALWAYS the Path; a redirector is only ever a named
        // "Source="/"ElementName="/"RelativeSource=" argument. So a positional path that happens to
        // equal a redirector keyword must still complete (no '=' means it is a value, not an argument).
        Assert.Equal("ClassicBindPath:|Source", Classify("<TextBlock Text=\"{Binding Source|}\" />"));
    }

    [Fact]
    public void ClassicBinding_BarePositionalElementName_IsStillBindPath()
    {
        Assert.Equal("ClassicBindPath:|ElementName", Classify("<TextBlock Text=\"{Binding ElementName|}\" />"));
    }

    [Fact]
    public void ClassicBinding_NamedSourceArgument_StillSuppressesPath()
    {
        // The named form (with '=') is a real redirector and must still decline.
        Assert.DoesNotContain("BindPath", Classify("<TextBlock Text=\"{Binding Source=|}\" />"));
    }

    // --- design-time DataContext type parsing (round 52: d:DataContext="{d:DesignInstance ...}") -----

    [Theory]
    [InlineData("{d:DesignInstance Type=local:Foo}", "local:Foo")]
    [InlineData("{d:DesignInstance local:Foo}", "local:Foo")]                                   // positional Type
    [InlineData("{d:DesignInstance Type=local:Foo, IsDesignTimeCreatable=True}", "local:Foo")]  // extra named arg
    [InlineData("{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Foo}", "local:Foo")]  // Type after another named arg
    [InlineData("{d:DesignInstance {x:Type local:Foo}}", "local:Foo")]                          // wrapped positional
    [InlineData("{d:DesignInstance Type={x:Type local:Foo}}", "local:Foo")]                     // wrapped Type=
    [InlineData("{d:DesignInstance MyViewModel}", "MyViewModel")]                               // unprefixed type
    [InlineData("  {d:DesignInstance   Type = local:Foo }  ", "local:Foo")]                     // whitespace tolerant
    public void ParseDesignInstanceType_ExtractsType(string value, string expected)
    {
        Assert.Equal(expected, CompletionProvider.ParseDesignInstanceType(value));
    }

    [Theory]
    [InlineData("{StaticResource DesignVm}")]   // a different extension is not a DataContext type
    [InlineData("{Binding}")]
    [InlineData("{d:DesignInstance}")]           // DesignInstance with no type token
    [InlineData("{d:DesignInstance Type=}")]     // empty Type value
    [InlineData("local:Foo")]                    // not a markup extension at all
    [InlineData("")]
    [InlineData(null)]
    public void ParseDesignInstanceType_ReturnsNullForNonDesignInstanceOrTypeless(string? value)
    {
        Assert.Null(CompletionProvider.ParseDesignInstanceType(value));
    }

    // --- x:DataType value type completion (round 54) ----------------------------------------------
    // The completion of types happens in CompleteAttributeValue (needs a real type system); these lock
    // the classifier contract it relies on: the attribute name is captured WITH its x: prefix, so the
    // exact-match branch fires for x:DataType and NOT for other x: directives (x:Name/x:Key).

    [Fact]
    public void XDataTypeValue_PrefixedPartial_CarriesPrefixedAttributeName()
    {
        Assert.Equal("AttributeValue:x:DataType:local:Gree", Classify("<DataTemplate x:DataType=\"local:Gree|\">"));
    }

    [Fact]
    public void XDataTypeValue_EmptyPartial_CarriesPrefixedAttributeName()
    {
        Assert.Equal("AttributeValue:x:DataType:", Classify("<DataTemplate x:DataType=\"|\">"));
    }

    [Fact]
    public void XDataTypeValue_DefaultNamespacePartial_CarriesPrefixedAttributeName()
    {
        Assert.Equal("AttributeValue:x:DataType:Butt", Classify("<DataTemplate x:DataType=\"Butt|\">"));
    }

    [Fact]
    public void XNameValue_RendersUnderItsOwnDirective_NotXDataType()
    {
        // Only x:DataType is special-cased for type completion; x:Name (a name directive) is distinct.
        Assert.Equal("AttributeValue:x:Name:local:Foo", Classify("<DataTemplate x:Name=\"local:Foo|\">"));
    }

    // --- {d:DesignInstance …} type-argument completion (round 57) ----------------------------------
    // Classification is purely LEXICAL (no scope): the extension PREFIX is carried in the render's middle
    // field (DesignInstanceType:<prefix>:<partial>) so completion can gate it to a design-time namespace.

    [Fact]
    public void DesignInstancePositionalType_ClassifiesWithPrefixAndPartial()
    {
        Assert.Equal("DesignInstanceType:d:local:Fo",
            Classify("<Grid d:DataContext=\"{d:DesignInstance local:Fo|}\" />"));
    }

    [Fact]
    public void DesignInstancePositionalType_Empty_CarriesEmptyPartial()
    {
        Assert.Equal("DesignInstanceType:d:",
            Classify("<Grid d:DataContext=\"{d:DesignInstance |}\" />"));
    }

    [Fact]
    public void DesignInstanceNamedType_ClassifiesWithPrefixAndPartial()
    {
        Assert.Equal("DesignInstanceType:d:local:Fo",
            Classify("<Grid d:DataContext=\"{d:DesignInstance Type=local:Fo|}\" />"));
    }

    [Fact]
    public void DesignInstanceNamedType_Empty_CarriesEmptyPartial()
    {
        Assert.Equal("DesignInstanceType:d:",
            Classify("<Grid d:DataContext=\"{d:DesignInstance Type=|}\" />"));
    }

    [Fact]
    public void DesignInstanceTypeAfterOtherArg_StillClassifies()
    {
        Assert.Equal("DesignInstanceType:d:local:Fo",
            Classify("<Grid d:DataContext=\"{d:DesignInstance IsDesignTimeCreatable=True, Type=local:Fo|}\" />"));
    }

    [Fact]
    public void DesignInstanceForeignPrefix_StillClassifies_GateIsInCompletion()
    {
        // A foreign/undeclared prefix still classifies lexically (carrying its prefix); the design-time
        // namespace gate lives in CompleteDesignInstanceType, which needs a namespace scope.
        Assert.Equal("DesignInstanceType:zzz:local:Fo",
            Classify("<Grid d:DataContext=\"{zzz:DesignInstance local:Fo|}\" />"));
    }

    [Fact]
    public void DesignInstanceUnprefixed_IsNotDesignInstanceType()
    {
        // DesignInstance is always prefixed; an unprefixed {DesignInstance …} is not the extension.
        Assert.DoesNotContain("DesignInstanceType", Classify("<Grid d:DataContext=\"{DesignInstance local:Fo|}\" />"));
    }

    [Fact]
    public void DesignInstanceNonTypeNamedArg_IsNotDesignInstanceType()
    {
        // IsDesignTimeCreatable= is a bool arg, not a type reference.
        Assert.DoesNotContain("DesignInstanceType", Classify("<Grid d:DataContext=\"{d:DesignInstance IsDesignTimeCreatable=|}\" />"));
    }

    [Fact]
    public void DesignInstanceSecondPositionalArg_IsNotDesignInstanceType()
    {
        // Only the FIRST positional argument is the type; a later positional gap is not.
        Assert.DoesNotContain("DesignInstanceType", Classify("<Grid d:DataContext=\"{d:DesignInstance local:Foo, |}\" />"));
    }

    [Fact]
    public void DesignInstanceEndedToken_IsNotDesignInstanceType()
    {
        // A completed type token followed by whitespace has ended — no type completion in the gap.
        Assert.DoesNotContain("DesignInstanceType", Classify("<Grid d:DataContext=\"{d:DesignInstance local:Foo |}\" />"));
    }

    [Fact]
    public void DesignInstanceWrappedXType_ClassifiesViaInnerXType()
    {
        // The wrapped {d:DesignInstance {x:Type local:Fo|}} form is handled by the inner {x:Type}
        // classifier via innermost-brace re-rooting, so it classifies as a plain TypeName reference.
        Assert.Equal("TypeName:local:Fo",
            Classify("<Grid d:DataContext=\"{d:DesignInstance {x:Type local:Fo|}}\" />"));
    }
}
