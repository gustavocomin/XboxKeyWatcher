param([string]$Text = 'KEY XBOX anunciada')
# Window on top of everything with sound, until closed (key-alert.mjs).
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object Windows.Forms.Form
$f.Text = 'XboxKeyWatcher - KEY ANUNCIADA'; $f.TopMost = $true; $f.StartPosition = 'CenterScreen'
$f.Size = New-Object Drawing.Size(720, 260); $f.BackColor = [Drawing.Color]::FromArgb(16, 124, 16)
$l = New-Object Windows.Forms.Label
$l.Text = $Text; $l.ForeColor = 'White'; $l.Font = New-Object Drawing.Font('Segoe UI', 18, [Drawing.FontStyle]::Bold)
$l.Dock = 'Fill'; $l.TextAlign = 'MiddleCenter'
$f.Controls.Add($l)
$t = New-Object Windows.Forms.Timer; $t.Interval = 1500; $n = 0
$t.Add_Tick({ if ($script:n -lt 6) { [System.Media.SystemSounds]::Exclamation.Play(); $script:n++ }; $f.Activate() })
$f.Add_Shown({ [System.Media.SystemSounds]::Exclamation.Play(); $t.Start(); $f.Activate() })
[void]$f.ShowDialog()
