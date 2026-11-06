using System.Collections.Generic;

namespace TestFixtureApp.Samples;

// Source for the --behaviors "sample typed groups" group. The surface's type model reads this project's .cs files
// (the client sends a document path inside it), and the user DLL supplies the runtime types the groups are built as.

/// <summary>Stands in for a page's code-behind: the x:Class the live XAML names.</summary>
public sealed partial class GroupsHost
{
    public List<PersonGroup> People { get; } = new();
    public List<Team> Teams { get; } = new();
}

public sealed class Person
{
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
}

/// <summary>A group that is its own item list.</summary>
public sealed class PersonGroup : List<Person>
{
    public string Key { get; set; } = "";
}

/// <summary>A group whose items sit under an ItemsPath property.</summary>
public sealed class Team
{
    public string Key { get; set; } = "";
    public List<Person> Members { get; set; } = new();
}
