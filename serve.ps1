$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:4200/")
$listener.Start()
Write-Host "Tiger Foundation Dashboard running at http://localhost:4200"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$mime = @{
    ".html"        = "text/html; charset=utf-8"
    ".json"        = "application/json"
    ".webmanifest" = "application/manifest+json"
    ".js"          = "text/javascript"
    ".png"         = "image/png"
    ".svg"         = "image/svg+xml"
    ".css"         = "text/css"
}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $res.AddHeader("Access-Control-Allow-Origin", "*")

    $path = $req.Url.LocalPath

    # POST /_save?name=<file>  → write request body to <root>/<file> (local dev asset generation)
    if ($req.HttpMethod -eq "POST" -and $path -eq "/_save") {
        $name = [System.IO.Path]::GetFileName($req.QueryString["name"])
        if ([string]::IsNullOrEmpty($name)) {
            $res.StatusCode = 400; $res.Close(); continue
        }
        $ms = New-Object System.IO.MemoryStream
        $req.InputStream.CopyTo($ms)
        [System.IO.File]::WriteAllBytes((Join-Path $root $name), $ms.ToArray())
        $res.StatusCode = 200
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("saved $name ($($ms.Length) bytes)")
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
        continue
    }

    if ($path -eq "/" -or $path -eq "/index.html") {
        $file = Join-Path $root "vercel\index.html"
    } else {
        $file = Join-Path $root ($path.TrimStart("/") -replace "/", "\")
    }

    if ((Test-Path $file) -and -not (Get-Item $file).PSIsContainer) {
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        $ct = $mime[$ext]
        if (-not $ct) { $ct = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $res.StatusCode = 200
        $res.ContentType = $ct
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $res.StatusCode = 404
    }
    $res.Close()
}
