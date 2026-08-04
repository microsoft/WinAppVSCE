$ErrorActionPreference = 'Stop'

$module = Import-Module (Join-Path $PSScriptRoot 'vscode-drive.psm1') -Force -PassThru

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) {
        throw "$Message. Expected $Expected, got $Actual."
    }
}

$taskDefault = & $module {
    Get-VSCodeDriverCommandTimeout -WaitForTask $true -TaskTimeoutSec 120 -TimeoutSec 0
}
Assert-Equal $taskDefault 130 'Task-waiting commands must reserve driver completion time'

$raisedExplicit = & $module {
    Get-VSCodeDriverCommandTimeout -WaitForTask $true -TaskTimeoutSec 90 -TimeoutSec 90
}
Assert-Equal $raisedExplicit 100 'An explicit outer timeout must not mask the structured task timeout'

$largerExplicit = & $module {
    Get-VSCodeDriverCommandTimeout -WaitForTask $true -TaskTimeoutSec 90 -TimeoutSec 150
}
Assert-Equal $largerExplicit 150 'A sufficient explicit outer timeout should be preserved'

$ordinaryDefault = & $module {
    Get-VSCodeDriverCommandTimeout -WaitForTask $false -TaskTimeoutSec 120 -TimeoutSec 0
}
Assert-Equal $ordinaryDefault 120 'Commands without task waiting should retain the existing default'

$zeroRejected = $false
try {
    & $module {
        Get-VSCodeDriverCommandTimeout -WaitForTask $true -TaskTimeoutSec 0 -TimeoutSec 0
    }
} catch {
    $zeroRejected = $_.Exception.Message -match 'greater than zero'
}
Assert-Equal $zeroRejected $true 'A zero task timeout must be rejected'

$negativeRejected = $false
try {
    & $module {
        Get-VSCodeDriverCommandTimeout -WaitForTask $false -TaskTimeoutSec -1 -TimeoutSec 120
    }
} catch {
    $negativeRejected = $_.Exception.Message -match 'greater than zero'
}
Assert-Equal $negativeRejected $true 'A negative task timeout must be rejected'

$options = @{ toolName = 'mt'; argumentText = '-manifest input.manifest' }
$answer = @{ accept = $true }
$plan = & $module {
    param($options, $answer)
    New-VSCodeDriverCommandPlan `
        -CommandId 'winapp.tool' `
        -CommandArgs @($options) `
        -Answers @($answer) `
        -WaitForTask $true `
        -TaskName 'Run SDK Tool' `
        -TaskSource 'WinApp' `
        -TaskTimeoutSec 90 `
        -SettleMs 500 `
        -TimeoutSec 90
} $options $answer
Assert-Equal $plan.Step.type 'command' 'All driver commands must use one unified step type'
Assert-Equal $plan.Step.args[0].toolName 'mt' 'Command arguments must be serialized'
Assert-Equal $plan.Step.answers[0].accept $true 'Answers must be serialized alongside arguments'
Assert-Equal $plan.Step.taskTimeoutMs 90000 'Task timeout must be serialized in milliseconds'
Assert-Equal $plan.TimeoutSec 100 'Outer timeout must exceed the serialized task timeout'

$probeSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'probe-tool-injection.ps1') -Raw
Assert-Equal `
    $probeSource.Contains('$escapedMarker = $marker.Replace("''", "''''")') `
    $true `
    'The injection probe must escape apostrophes in the marker path'
Assert-Equal `
    $probeSource.Contains('$payload = "/?; Set-Content ''$escapedMarker'' owned"') `
    $true `
    'The injection payload must embed the escaped marker path'

Write-Host 'vscode-drive timeout tests passed'
