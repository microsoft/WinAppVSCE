namespace SmokeFixture;

/// <summary>
/// Transient view-model consumed by the constructor-injected <see cref="DiPage"/>.
/// Receives <see cref="IGreetingService"/> through DI so a test can reload a
/// DI-constructed page graph via <see cref="App.Services"/>.
/// </summary>
public sealed class DiPageViewModel
{
    private readonly IGreetingService _greetingService;

    public DiPageViewModel(IGreetingService greetingService)
    {
        _greetingService = greetingService;
    }

    public string Message => $"{_greetingService.GetGreeting()} — resolved into DiPageViewModel";
}
