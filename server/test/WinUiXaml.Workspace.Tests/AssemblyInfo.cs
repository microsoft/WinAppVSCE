// xUnit 2.3.1's parallel collection scheduler can stall the MSBuild/Roslyn integration tests.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
