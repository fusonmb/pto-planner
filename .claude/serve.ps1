$ErrorActionPreference='Stop'
$root = 'C:\Users\mfuson\claudeACI'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8765/')
$listener.Start()
Write-Host "serving $root on http://localhost:8765/"
$ctypes=@{'.html'='text/html; charset=utf-8';'.json'='application/json';'.geojson'='application/json';'.js'='text/javascript';'.css'='text/css'}
while($listener.IsListening){
  $ctx=$listener.GetContext()
  try{
    $rel=[Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if($rel -eq ''){ $rel='colorado-fire-restrictions.html' }
    $path=Join-Path $root $rel
    if(Test-Path $path -PathType Leaf){
      $bytes=[IO.File]::ReadAllBytes($path)
      $ext=[IO.Path]::GetExtension($path).ToLower()
      if($ctypes.ContainsKey($ext)){ $ctx.Response.ContentType=$ctypes[$ext] }
      $ctx.Response.OutputStream.Write($bytes,0,$bytes.Length)
    } else { $ctx.Response.StatusCode=404 }
  } catch { try{ $ctx.Response.StatusCode=500 }catch{} }
  $ctx.Response.Close()
}
