param([string]$RequestFile, [switch]$List)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($List) {
        $voices = @($speech.GetInstalledVoices() | Where-Object Enabled | ForEach-Object {
            @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name }
        })
        ConvertTo-Json -InputObject $voices -Compress
    } else {
        $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $speech.SelectVoice([string]$request.voice)
        $speech.Rate = [int]$request.rate
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $speech.SetOutputToWaveFile([string]$request.output, $format)
        $speech.Speak([string]$request.text)
        $speech.SetOutputToNull()
    }
} finally {
    $speech.Dispose()
}
