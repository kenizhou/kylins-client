# Test an IMAP4 LOGIN over STARTTLS on port 143.
# Run this from the host or the VM. The password is read from -Password
# or prompted at runtime so it isn't stored in the script.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)] [string] $Server = 'imap.kylins.com',
    [Parameter(Mandatory = $false)] [int]    $Port   = 143,
    [Parameter(Mandatory = $true )] [string] $User,
    [Parameter(Mandatory = $false)] [string] $Password
)

# Accept the self-signed / internal-CA Exchange certificate.
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

if (-not $Password) {
    $sec = Read-Host -AsSecureString 'IMAP password'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$client = New-Object System.Net.Sockets.TcpClient($Server, $Port)
$s = $client.GetStream()

$rd = New-Object System.IO.StreamReader($s)
$wr = New-Object System.IO.StreamWriter($s); $wr.AutoFlush = $true

Write-Host ('S: ' + $rd.ReadLine())

$wr.WriteLine('a1 CAPABILITY')
Write-Host 'C: a1 CAPABILITY'
while (($l = $rd.ReadLine()) -ne $null -and $l -ne '') { Write-Host ('S: ' + $l) }

$wr.WriteLine('a2 STARTTLS')
Write-Host 'C: a2 STARTTLS'
$rd.ReadLine() | ForEach-Object { Write-Host ('S: ' + $_) }

$ssl = New-Object System.Net.Security.SslStream($s, $false, { $true })
$ssl.AuthenticateAsClient($Server)
Write-Host ("TLS: {0} {1}" -f $ssl.SslProtocol, $ssl.CipherAlgorithm)
Write-Host ("Cert subject: {0}" -f $ssl.RemoteCertificate.Subject)

$sr = New-Object System.IO.StreamReader($ssl)
$sw = New-Object System.IO.StreamWriter($ssl); $sw.AutoFlush = $true

$sw.WriteLine('a3 LOGIN "{0}" "{1}"' -f $User, $Password)
Write-Host ('C: a3 LOGIN ... (password redacted)')
$line = $sr.ReadLine()
Write-Host ('S: ' + $line)

$sw.WriteLine('a4 LOGOUT')
$sr.ReadLine() | Out-Null

$ssl.Close(); $client.Close()