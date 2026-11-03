namespace SmokeFixture;

/// <summary>
/// Trivial service registered as a singleton in the DI container. Supplies the greeting
/// string consumed by the landing page (<see cref="SmokePage.GreetingText"/>) and the
/// constructor-injected <see cref="DiPage"/> via <see cref="DiPageViewModel"/>.
/// </summary>
public interface IGreetingService
{
    string GetGreeting();
}

/// <summary>Default <see cref="IGreetingService"/> implementation.</summary>
public sealed class GreetingService : IGreetingService
{
    public string GetGreeting() => "Hello from SmokeFixture (DI singleton)";
}
