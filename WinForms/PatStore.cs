using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration.UserSecrets;

namespace CherryPickPromotion.WinForms;

/// <summary>
/// Remembers the PAT in this project's user secrets file. The file is plain JSON in the user's profile, outside the
/// repository; it is not encrypted. Also settable with: dotnet user-secrets set AzureDevOps:Pat &lt;token&gt;
/// </summary>
internal static class PatStore
{
    private const string key = "AzureDevOps:Pat";

    private static readonly string path = PathHelper.GetSecretsPathFromSecretsId(
        typeof(PatStore).Assembly.GetCustomAttribute<UserSecretsIdAttribute>()!.UserSecretsId);

    public static string? Load()
    {
        try
        {
            return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))?[key]?.GetValue<string>() : null;
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public static void Save(string? pat)
    {
        // Keep anything else in the file, such as values set with dotnet user-secrets.
        var secrets = (File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject : null) ?? [];
        if (pat is null)
        {
            if (!secrets.Remove(key))
                return;
        }
        else
        {
            secrets[key] = pat;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, secrets.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
