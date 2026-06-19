# sync_dashboard.ps1
# Daily sync for Team RISE Dashboard data.
# Runs: Recruit Tracker sheet sync + production client cache refresh.
# Scheduled via Windows Task Scheduler — runs every morning at 6 AM PT.

$ScriptDir = "C:\Users\Mouth\bscpro-scraper"
Set-Location $ScriptDir
$LogFile   = "$ScriptDir\data\sync_dashboard.log"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Log($msg) {
    $line = "[$Timestamp] $msg"
    Write-Output $line
    Add-Content -Path $LogFile -Value $line
}

Log "=== Dashboard sync started ==="

# 1. Sync Recruit Tracker to Google Sheet
Log "Step 1: Syncing Recruit Tracker..."
$result = & node "$ScriptDir\scrape.js" 2>&1
if ($LASTEXITCODE -eq 0) {
    Log "  Recruit Tracker sync complete."
} else {
    Log "  ERROR: Recruit Tracker sync failed (exit $LASTEXITCODE)"
    Log "  $result"
}

# 2. Refresh production clients cache
Log "Step 2: Refreshing production clients..."
$result2 = & node "$ScriptDir\scrape_production_clients.js" --force 2>&1
if ($LASTEXITCODE -eq 0) {
    Log "  Production clients refresh complete."
} else {
    Log "  ERROR: Production clients refresh failed (exit $LASTEXITCODE)"
    Log "  $result2"
}

# 3. Scrape fresh GX stats and push to Supabase
Log "Step 3: Syncing GX stats..."
$result3 = & node "$ScriptDir\scrape_gx_baseshop_jun2026.js" 2>&1
if ($LASTEXITCODE -eq 0) {
    Log "  GX scrape complete."
    $result4 = & node "C:\Users\Mouth\team-rise-v2\push_gx_to_supabase.mjs" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Log "  GX data pushed to Supabase."
    } else {
        Log "  ERROR: GX Supabase push failed (exit $LASTEXITCODE)"
        Log "  $result4"
    }
} else {
    Log "  ERROR: GX scrape failed (exit $LASTEXITCODE)"
    Log "  $result3"
}

Log "=== Dashboard sync finished ==="
