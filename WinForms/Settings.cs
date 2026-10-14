using System.Text.Json;

namespace CherryPickPromotion.WinForms;

/// <summary>Remembers the organization and project between runs. The PAT is remembered separately, in <see cref="PatStore"/>.</summary>
internal sealed record Settings(string OrganizationUrl, string Project)
{
    private static readonly string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CherryPickPromotion", "settings.json");

    public static Settings Load()
    {
        try
        {
            if (File.Exists(path))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(path)) ?? new Settings("", "");
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
        }
        return new Settings("", "");
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this));
    }
}
