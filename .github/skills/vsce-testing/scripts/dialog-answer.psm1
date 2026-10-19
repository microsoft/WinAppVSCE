function Invoke-ModalButton {
    param([int64]$Hwnd, [string]$Name)
    Start-Sleep -Seconds 2
    return (winapp ui invoke -w $Hwnd $Name 2>&1 | Out-String).Trim() -replace '\s+', ' '
}
