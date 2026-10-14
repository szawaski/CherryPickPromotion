using System.Diagnostics;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CherryPickPromotion.WinForms;

/// <summary>
/// Hosts the same web UI the Azure DevOps extension uses. The page is served from wwwroot under
/// https://cherrypick.local/ and calls https://cherrypick.local/ado/..., which this form forwards to the
/// organization with the PAT. Same origin means no CORS, and the PAT never reaches the page.
/// </summary>
internal sealed class MainForm : Form
{
    private const string appHost = "cherrypick.local";
    private const string adoPrefix = "/ado/";

    private readonly TextBox organizationBox = new() { Width = 280, PlaceholderText = "https://dev.azure.com/your-org" };
    private readonly TextBox projectBox = new() { Width = 180 };
    private readonly TextBox patBox = new() { Width = 260, UseSystemPasswordChar = true };
    private readonly CheckBox rememberBox = new() { Text = "Remember token", AutoSize = true, Margin = new Padding(8, 5, 2, 0) };
    private readonly Button connectButton = new() { Text = "Connect", AutoSize = true, Enabled = false };
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly HttpClient httpClient = new();
    private readonly string webRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "wwwroot"));

    private Uri? organizationUrl;
    private string? authorization;

    public MainForm()
    {
        Text = "Cherry-Pick Promotion";
        var workingArea = Screen.FromPoint(Cursor.Position).WorkingArea;
        Size = new Size(workingArea.Width * 85 / 100, workingArea.Height * 85 / 100);
        StartPosition = FormStartPosition.CenterScreen;
        AcceptButton = connectButton;

        var settings = Settings.Load();
        organizationBox.Text = settings.OrganizationUrl;
        projectBox.Text = settings.Project;
        var rememberedPat = PatStore.Load();
        patBox.Text = rememberedPat ?? "";
        rememberBox.Checked = rememberedPat is not null;

        var bar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8), WrapContents = true };
        bar.Controls.AddRange(
        [
            Caption("Organization URL"), organizationBox,
            Caption("Project"), projectBox,
            Caption("Personal access token"), patBox,
            rememberBox,
            connectButton,
            PatHelp()
        ]);
        bar.SetFlowBreak(connectButton, true);

        Controls.Add(webView);
        Controls.Add(bar);

        connectButton.Click += (_, _) => Connect();
        Load += async (_, _) => await InitializeWebViewAsync();
    }

    private static Label Caption(string text) => new() { Text = text, AutoSize = true, Margin = new Padding(8, 7, 2, 0) };

    private LinkLabel PatHelp()
    {
        const string linkText = "Create a token";
        var help = new LinkLabel
        {
            Text = $"The token needs the Code (Read, write, & manage) and Work Items (Read & write) scopes for this organization. {linkText}",
            AutoSize = true,
            Margin = new Padding(8, 2, 2, 0)
        };
        help.LinkArea = new LinkArea(help.Text.Length - linkText.Length, linkText.Length);
        help.LinkClicked += (_, _) =>
        {
            var organization = organizationBox.Text.Trim().TrimEnd('/');
            OpenExternal(Uri.TryCreate(organization, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps
                ? $"{organization}/_usersSettings/tokens"
                : "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate");
        };
        return help;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CherryPickPromotion", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await webView.EnsureCoreWebView2Async(environment);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"WebView2 could not start: {ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var core = webView.CoreWebView2;
        core.AddWebResourceRequestedFilter($"https://{appHost}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (new Uri(e.Uri).Host != appHost)
            {
                e.Cancel = true;
                OpenExternal(e.Uri);
            }
        };

        connectButton.Enabled = true;
        if (organizationBox.Text.Length > 0 && projectBox.Text.Length > 0)
        {
            // With a remembered token there is nothing left to enter.
            if (patBox.Text.Length > 0)
                Connect();
            else
                patBox.Select();
        }
    }

    private void Connect()
    {
        var organization = organizationBox.Text.Trim().TrimEnd('/');
        var project = projectBox.Text.Trim();
        var pat = patBox.Text.Trim();

        if (!Uri.TryCreate(organization + "/", UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps)
        {
            MessageBox.Show(this, "Enter the organization URL, e.g. https://dev.azure.com/your-org", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (project.Length == 0 || pat.Length == 0)
        {
            MessageBox.Show(this, "Enter the project and a personal access token with the Code (Read, write, & manage) and Work Items (Read & write) scopes.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        organizationUrl = url;
        authorization = "Basic " + Convert.ToBase64String(Encoding.ASCII.GetBytes(":" + pat));
        new Settings(organization, project).Save();
        try
        {
            PatStore.Save(rememberBox.Checked ? pat : null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            MessageBox.Show(this, $"Connected, but the token couldn't be saved to user secrets: {ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        webView.CoreWebView2.Navigate($"https://{appHost}/index.html?project={Uri.EscapeDataString(project)}");
    }

    private async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            var requestUri = new Uri(e.Request.Uri);
            e.Response = requestUri.AbsolutePath.StartsWith(adoPrefix, StringComparison.Ordinal)
                ? await ProxyAsync(e.Request, requestUri)
                : ServeFile(requestUri);
        }
        catch (Exception ex)
        {
            e.Response = CreateResponse(502, "Bad Gateway", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(ex.Message));
        }
        finally
        {
            deferral.Complete();
        }
    }

    private async Task<CoreWebView2WebResourceResponse> ProxyAsync(CoreWebView2WebResourceRequest webRequest, Uri requestUri)
    {
        if (organizationUrl is null || authorization is null)
            return CreateResponse(401, "Unauthorized", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not connected."));

        var target = new Uri(organizationUrl, requestUri.PathAndQuery[adoPrefix.Length..]);
        if (!organizationUrl.IsBaseOf(target))
            return CreateResponse(400, "Bad Request", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Requests must stay within the organization."));

        using var request = new HttpRequestMessage(new HttpMethod(webRequest.Method), target);
        request.Headers.TryAddWithoutValidation("Authorization", authorization);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");

        // The request body stream has to be read before the first await.
        if (webRequest.Content is not null)
        {
            using var body = new MemoryStream();
            webRequest.Content.CopyTo(body);
            request.Content = new ByteArrayContent(body.ToArray());
            if (webRequest.Headers.Contains("Content-Type"))
                request.Content.Headers.TryAddWithoutValidation("Content-Type", webRequest.Headers.GetHeader("Content-Type"));
        }

        using var response = await httpClient.SendAsync(request);
        var content = await response.Content.ReadAsByteArrayAsync();

        var headers = new StringBuilder();
        if (response.Content.Headers.ContentType is { } contentType)
            headers.Append("Content-Type: ").Append(contentType).Append("\r\n");
        foreach (var name in (string[])["x-ms-continuationtoken", "x-tfs-serviceerror"])
        {
            if (response.Headers.TryGetValues(name, out var values))
                headers.Append(name).Append(": ").Append(string.Join(",", values)).Append("\r\n");
        }

        var status = (int)response.StatusCode;
        return webView.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(content), status, response.ReasonPhrase ?? response.StatusCode.ToString(), headers.ToString());
    }

    private CoreWebView2WebResourceResponse ServeFile(Uri requestUri)
    {
        var relative = Uri.UnescapeDataString(requestUri.AbsolutePath).TrimStart('/');
        var path = Path.GetFullPath(Path.Combine(webRoot, relative.Length == 0 ? "index.html" : relative));
        if (!path.StartsWith(webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
            return CreateResponse(404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not found."));

        var contentType = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".map" or ".json" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".ttf" => "font/ttf",
            _ => "application/octet-stream"
        };
        return CreateResponse(200, "OK", contentType, File.ReadAllBytes(path));
    }

    private CoreWebView2WebResourceResponse CreateResponse(int status, string reason, string contentType, byte[] content)
        => webView.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(content), status, reason, $"Content-Type: {contentType}\r\n");

    private static void OpenExternal(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var parsed) && (parsed.Scheme == Uri.UriSchemeHttps || parsed.Scheme == Uri.UriSchemeHttp))
            Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            httpClient.Dispose();
        base.Dispose(disposing);
    }
}
