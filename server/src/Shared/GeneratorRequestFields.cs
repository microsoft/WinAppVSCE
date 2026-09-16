namespace WinUiXaml.GeneratorProtocol
{
    /// <summary>
    /// Field names of the generator-host request. The writer and the reader live in separate projects, so a name that matches on only one side produces a request the host reads as absent rather than as a failure: generators then run against a silently incomplete compilation and emit members that disagree with the project's own build. Sharing the names makes that a compile error.
    /// </summary>
    internal static class GeneratorRequestFields
    {
        internal const string AssemblyName = "assemblyName";
        internal const string OutputDirectory = "outputDirectory";
        internal const string LanguageVersion = "languageVersion";
        internal const string OutputKind = "outputKind";
        internal const string AllowUnsafe = "allowUnsafe";
        internal const string NullableContext = "nullableContext";
        internal const string References = "references";
        internal const string Analyzers = "analyzers";
        internal const string Sources = "sources";
        internal const string AnalyzerConfigs = "analyzerConfigs";
        internal const string AdditionalFiles = "additionalFiles";
        internal const string PreprocessorSymbols = "preprocessorSymbols";
        internal const string ReferenceAliases = "referenceAliases";
        internal const string EmbeddedInteropReferences = "embeddedInteropReferences";
    }
}
