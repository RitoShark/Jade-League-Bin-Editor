using System;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jade.Services;

namespace Jade.Windows;

public partial class SettingsWindow : Window
{
    private readonly string _hashFolderPath;
    
    public SettingsWindow()
    {
        InitializeComponent();
        
        _hashFolderPath = HashDownloader.GetHashDirectory();
        
        // Show path and status
        HashFolderPath.Text = $"Location: {_hashFolderPath}";
        UpdateHashStatus();
        
        // Setup temp folder
        var tempFolder = GetTempFolderPath();
        TempFolderPath.Text = $"Location: {tempFolder}";
        
        // Load auto-clear preference
        LoadAutoClearPreference();
        
        // Load auto-download preference
        LoadAutoDownloadPreference();
        
        // Load preload hash preference
        LoadPreloadHashPreference();
        
        // Load binary format preference
        LoadBinaryFormatPreference();
        
        // Load minimize to tray preference
        LoadMinimizeToTrayPreference();
        
        // Load run at startup preference
        LoadRunAtStartupPreference();
        
        // Check file association status
        UpdateFileAssociationStatus();
        
        // Apply current theme
        ApplyWindowTheme(GetCurrentTheme());
        
        Logger.Info($"Settings window opened, hash folder: {_hashFolderPath}");
    }
    
    private string GetTempFolderPath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appDataPath, "RitoShark", "Jade", "temp");
    }
    
    private string GetPreferencesFilePath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
        Directory.CreateDirectory(jadeDir);
        return Path.Combine(jadeDir, "settings.txt");
    }
    
    private void LoadAutoClearPreference()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            bool enabled = true; // Default to enabled
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoClearTemp="))
                {
                    enabled = content.Contains("AutoClearTemp=True");
                }
            }
            else
            {
                // Default to true if no preference file exists
                SaveAutoClearPreference(true);
            }
            
            UpdateAutoClearButton(enabled);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load auto-clear preference", ex);
            UpdateAutoClearButton(true);
        }
    }
    
    private void UpdateAutoClearButton(bool enabled)
    {
        if (enabled)
        {
            AutoClearToggleButton.Content = "Auto-clear: Enabled";
            AutoClearToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(45, 122, 45)); // Green
        }
        else
        {
            AutoClearToggleButton.Content = "Auto-clear: Disabled";
            AutoClearToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(122, 45, 45)); // Red
        }
    }
    
    private void SaveAutoClearPreference(bool enabled)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            File.WriteAllText(prefsFile, $"AutoClearTemp={enabled}");
            Logger.Info($"Saved auto-clear preference: {enabled}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save auto-clear preference", ex);
        }
    }
    
    private void UpdateHashStatus()
    {
        var (allPresent, missing, format) = HashDownloader.CheckHashes();
        
        if (allPresent)
        {
            string formatText = format == "Binary" ? " (Binary format)" : 
                               format == "Mixed" ? " (Mixed format)" : "";
                               
            HashStatusText.Text = $"✓ All hash files are present{formatText}";
            HashStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(76, 175, 80)); // Green
        }
        else
        {
            HashStatusText.Text = $"⚠ Missing {missing.Count} hash file(s): {string.Join(", ", missing)}";
            HashStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(255, 152, 0)); // Orange
        }
    }
    
    private async void OnDownloadHashes(object sender, RoutedEventArgs e)
    {
        try
        {
            var button = sender as System.Windows.Controls.Button;
            if (button != null)
            {
                button.IsEnabled = false;
                button.Content = "Downloading...";
            }
            
            Logger.Info("Starting hash download");
            HashStatusText.Text = "Downloading hash files from CommunityDragon...";
            HashStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(33, 150, 243)); // Blue
            
            var progress = new Progress<(string Message, int Current, int Total)>(update =>
            {
                HashStatusText.Text = $"{update.Message} ({update.Current}/{update.Total})";
            });
            
            var (success, downloaded, errors) = await HashDownloader.DownloadHashesAsync(progress);
            
            if (button != null)
            {
                button.IsEnabled = true;
                button.Content = "Download Hashes";
            }
            
            if (success)
            {
                Logger.Info($"Successfully downloaded {downloaded.Count} hash files");
                MessageBox.Show(
                    $"Successfully downloaded {downloaded.Count} hash file(s)!\n\n" +
                    string.Join("\n", downloaded),
                    "Download Complete",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            else
            {
                Logger.Error($"Hash download completed with {errors.Count} errors", null);
                MessageBox.Show(
                    $"Downloaded {downloaded.Count} file(s) with {errors.Count} error(s):\n\n" +
                    string.Join("\n", errors),
                    "Download Completed with Errors",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }
            
            UpdateHashStatus();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to download hashes", ex);
            MessageBox.Show($"Failed to download hashes: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
            
            var button = sender as System.Windows.Controls.Button;
            if (button != null)
            {
                button.IsEnabled = true;
                button.Content = "Download Hashes";
            }
            
            UpdateHashStatus();
        }
    }
    
    private void OnOpenHashesFolder(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info($"Opening hash folder: {_hashFolderPath}");
            
            // Open folder in Explorer
            Process.Start(new ProcessStartInfo
            {
                FileName = _hashFolderPath,
                UseShellExecute = true,
                Verb = "open"
            });
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open hash folder", ex);
            MessageBox.Show($"Failed to open folder: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnClearTempFolder(object sender, RoutedEventArgs e)
    {
        try
        {
            var tempFolder = GetTempFolderPath();
            
            if (!Directory.Exists(tempFolder))
            {
                MessageBox.Show("Temp folder is already empty.", "Info",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            var files = Directory.GetFiles(tempFolder);
            var fileCount = files.Length;
            
            if (fileCount == 0)
            {
                MessageBox.Show("Temp folder is already empty.", "Info",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            foreach (var file in files)
            {
                try
                {
                    File.Delete(file);
                }
                catch (Exception ex)
                {
                    Logger.Error($"Failed to delete temp file: {file}", ex);
                }
            }
            
            Logger.Info($"Cleared {fileCount} file(s) from temp folder");
            MessageBox.Show($"Cleared {fileCount} temporary file(s).", "Success",
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to clear temp folder", ex);
            MessageBox.Show($"Failed to clear temp folder: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnOpenTempFolder(object sender, RoutedEventArgs e)
    {
        try
        {
            var tempFolder = GetTempFolderPath();
            
            // Create the temp folder if it doesn't exist
            if (!Directory.Exists(tempFolder))
            {
                Directory.CreateDirectory(tempFolder);
                Logger.Info("Created temp folder");
            }
            
            // Open the folder in Windows Explorer
            Process.Start(new ProcessStartInfo
            {
                FileName = tempFolder,
                UseShellExecute = true,
                Verb = "open"
            });
            
            Logger.Info("Opened temp folder in Explorer");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open temp folder", ex);
            MessageBox.Show($"Failed to open temp folder: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnToggleAutoClear(object sender, RoutedEventArgs e)
    {
        try
        {
            // Read current state
            var prefsFile = GetPreferencesFilePath();
            bool currentlyEnabled = true;
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoClearTemp="))
                {
                    currentlyEnabled = content.Contains("AutoClearTemp=True");
                }
            }
            
            // Toggle state
            bool newState = !currentlyEnabled;
            SaveAutoClearPreference(newState);
            UpdateAutoClearButton(newState);
            
            Logger.Info($"Auto-clear toggled to: {newState}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to toggle auto-clear", ex);
        }
    }
    
    private void LoadAutoDownloadPreference()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            bool enabled = false; // Default to disabled
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoDownloadHashes="))
                {
                    enabled = content.Contains("AutoDownloadHashes=True");
                }
            }
            
            UpdateAutoDownloadButton(enabled);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load auto-download preference", ex);
            UpdateAutoDownloadButton(false);
        }
    }
    
    private void UpdateAutoDownloadButton(bool enabled)
    {
        if (enabled)
        {
            AutoDownloadToggleButton.Content = "Auto-download: Enabled";
            AutoDownloadToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(45, 122, 45)); // Green
        }
        else
        {
            AutoDownloadToggleButton.Content = "Auto-download: Disabled";
            AutoDownloadToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(122, 45, 45)); // Red
        }
    }
    
    private void SaveAutoDownloadPreference(bool enabled)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new System.Collections.Generic.List<string>();
            
            // Read existing preferences
            if (File.Exists(prefsFile))
            {
                var existingLines = File.ReadAllLines(prefsFile);
                foreach (var line in existingLines)
                {
                    if (!line.StartsWith("AutoDownloadHashes="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            // Add the new preference
            lines.Add($"AutoDownloadHashes={enabled}");
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved auto-download preference: {enabled}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save auto-download preference", ex);
        }
    }
    
    private void OnToggleAutoDownload(object sender, RoutedEventArgs e)
    {
        try
        {
            // Read current state
            var prefsFile = GetPreferencesFilePath();
            bool currentlyEnabled = false;
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoDownloadHashes="))
                {
                    currentlyEnabled = content.Contains("AutoDownloadHashes=True");
                }
            }
            
            // Toggle state
            bool newState = !currentlyEnabled;
            SaveAutoDownloadPreference(newState);
            UpdateAutoDownloadButton(newState);
            
            Logger.Info($"Auto-download hashes toggled to: {newState}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to toggle auto-download", ex);
        }
    }
    
    private void LoadPreloadHashPreference()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            bool enabled = false; // Default to disabled (low RAM)
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("PreloadHashes="))
                {
                    enabled = content.Contains("PreloadHashes=True");
                }
            }
            
            UpdatePreloadHashButton(enabled);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load preload hash preference", ex);
            UpdatePreloadHashButton(false);
        }
    }
    
    private void UpdatePreloadHashButton(bool enabled)
    {
        if (enabled)
        {
            PreloadHashToggleButton.Content = "Preload hashes: Enabled";
            PreloadHashToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(45, 122, 45)); // Green
        }
        else
        {
            PreloadHashToggleButton.Content = "Preload hashes: Disabled";
            PreloadHashToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(122, 45, 45)); // Red
        }
    }
    
    private void SavePreloadHashPreference(bool enabled)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new System.Collections.Generic.List<string>();
            
            // Read existing preferences
            if (File.Exists(prefsFile))
            {
                var existingLines = File.ReadAllLines(prefsFile);
                foreach (var line in existingLines)
                {
                    if (!line.StartsWith("PreloadHashes="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            // Add the new preference
            lines.Add($"PreloadHashes={enabled}");
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved preload hash preference: {enabled}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save preload hash preference", ex);
        }
    }
    
    private void OnTogglePreloadHash(object sender, RoutedEventArgs e)
    {
        try
        {
            // Read current state
            var prefsFile = GetPreferencesFilePath();
            bool currentlyEnabled = false;
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("PreloadHashes="))
                {
                    currentlyEnabled = content.Contains("PreloadHashes=True");
                }
            }
            
            // Toggle state
            bool newState = !currentlyEnabled;
            SavePreloadHashPreference(newState);
            UpdatePreloadHashButton(newState);
            
            Logger.Info($"Preload hashes toggled to: {newState}");
            
            MessageBox.Show(
                newState 
                    ? "Hash preloading enabled. Hashes will load at startup for instant bin conversion.\n\nIdle RAM usage: HIGH (~500MB)\n\nRestart the app to apply the changes."
                    : "Hash preloading disabled. Hashes will load/unload per file converted which will be slower.\n\nIdle RAM usage: VERY LOW (~40MB)\n\nRestart the app to apply the changes.",
                "Preload Hashes Setting Changed",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to toggle preload hash", ex);
        }
    }
    

    
    public static void ClearTempFolderOnStartup()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "settings.txt");
            
            // Check if auto-clear is enabled (default is true)
            bool autoClear = true;
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoClearTemp="))
                {
                    autoClear = content.Contains("AutoClearTemp=True");
                }
            }
            
            if (autoClear)
            {
                var tempFolder = Path.Combine(jadeDir, "temp");
                if (Directory.Exists(tempFolder))
                {
                    var files = Directory.GetFiles(tempFolder);
                    foreach (var file in files)
                    {
                        try
                        {
                            File.Delete(file);
                        }
                        catch { }
                    }
                    Logger.Info($"Auto-cleared {files.Length} file(s) from temp folder on startup");
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to auto-clear temp folder on startup", ex);
        }
    }
    
    public static async void DownloadHashesOnStartup(Action<string>? statusCallback = null)
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "settings.txt");
            
            // Check if auto-download is enabled (default is false)
            bool autoDownload = false;
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("AutoDownloadHashes="))
                {
                    autoDownload = content.Contains("AutoDownloadHashes=True");
                }
            }
            
            if (autoDownload)
            {
                Logger.Info("Auto-downloading hashes on startup");
                statusCallback?.Invoke("Downloading hash files...");
                
                var progress = new Progress<(string Message, int Current, int Total)>(update =>
                {
                    Logger.Info($"Hash download progress: {update.Message} ({update.Current}/{update.Total})");
                    statusCallback?.Invoke($"Downloading hashes: {update.Current}/{update.Total}");
                });
                
                var (success, downloaded, errors) = await HashDownloader.DownloadHashesAsync(progress);
                
                if (success)
                {
                    Logger.Info($"Auto-downloaded {downloaded.Count} hash file(s) on startup");
                    statusCallback?.Invoke($"Hash files downloaded ({downloaded.Count} files)");
                }
                else
                {
                    Logger.Error($"Auto-download completed with {errors.Count} error(s) on startup", null);
                    statusCallback?.Invoke($"Hash download completed with {errors.Count} error(s)");
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to auto-download hashes on startup", ex);
            statusCallback?.Invoke("Hash download failed");
        }
    }
    
    private void LoadBinaryFormatPreference()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            bool enabled = false; // Default to disabled
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("UseBinaryHashFormat="))
                {
                    enabled = content.Contains("UseBinaryHashFormat=True");
                }
            }
            
            UpdateBinaryFormatButton(enabled);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load binary format preference", ex);
            UpdateBinaryFormatButton(false);
        }
    }
    
    private void SaveBinaryFormatPreference(bool enabled)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = File.Exists(prefsFile) ? File.ReadAllLines(prefsFile).ToList() : new System.Collections.Generic.List<string>();
            
            // Remove existing setting
            lines.RemoveAll(l => l.StartsWith("UseBinaryHashFormat="));
            
            // Add new setting
            lines.Add($"UseBinaryHashFormat={enabled}");
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved binary format preference: {enabled}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save binary format preference", ex);
        }
    }
    
    private void UpdateBinaryFormatButton(bool enabled)
    {
        if (enabled)
        {
            BinaryFormatToggleButton.Content = "Binary format: Enabled";
            BinaryFormatToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(45, 122, 45)); // Green
        }
        else
        {
            BinaryFormatToggleButton.Content = "Binary format: Disabled";
            BinaryFormatToggleButton.Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(122, 45, 45)); // Red
        }
    }
    
    public async void OnToggleBinaryFormat(object sender, RoutedEventArgs e)
    {
        // The existing LoadBinaryFormatPreference() is private void and updates the button directly.
        // To make it async and return a bool, we need a new helper method or modify the existing one.
        // For simplicity and to match the pattern in the instruction, let's assume a helper that reads the current state.
        bool current = false;
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (File.Exists(prefsFile))
            {
                var content = await File.ReadAllTextAsync(prefsFile);
                if (content.Contains("UseBinaryHashFormat="))
                {
                    current = content.Contains("UseBinaryHashFormat=True");
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to read current binary format preference for toggle", ex);
        }

        bool newVal = !current;
        SaveBinaryFormatPreference(newVal);
        UpdateBinaryFormatButton(newVal);
    }

    private async Task<bool> LoadMinimizeToTrayPreference()
    {
        try
        {
            string prefsFile = GetPreferencesFilePath();
            if (File.Exists(prefsFile))
            {
                var lines = await File.ReadAllLinesAsync(prefsFile);
                foreach (var line in lines)
                {
                    if (line.StartsWith("MinimizeToTray="))
                    {
                        bool val = line.Substring(15).Trim() == "True";
                        UpdateMinimizeToTrayButton(val);
                        return val;
                    }
                }
            }
        }
        catch { }
        UpdateMinimizeToTrayButton(false);
        return false;
    }

    private void UpdateMinimizeToTrayButton(bool enabled)
    {
        MinimizeToTrayToggleButton.Content = $"Minimize to Tray: {(enabled ? "Enabled" : "Disabled")}";
        MinimizeToTrayToggleButton.Background = enabled ? 
            new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 122, 45)) : 
            new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(122, 45, 45));
            
        // Disable startup button if tray is disabled
        if (RunAtStartupToggleButton != null)
        {
            RunAtStartupToggleButton.IsEnabled = enabled;
            if (!enabled)
            {
                UpdateRunAtStartupButton(false);
                SaveRunAtStartupPreference(false);
            }
        }
    }

    private async void SaveMinimizeToTrayPreference(bool enabled)
    {
        try
        {
            string prefsFile = GetPreferencesFilePath();
            var lines = File.Exists(prefsFile) ? (await File.ReadAllLinesAsync(prefsFile)).ToList() : new List<string>();
            
            bool found = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("MinimizeToTray="))
                {
                    lines[i] = "MinimizeToTray=" + (enabled ? "True" : "False");
                    found = true;
                }
            }
            
            if (!found) lines.Add("MinimizeToTray=" + (enabled ? "True" : "False"));
            
            await File.WriteAllLinesAsync(prefsFile, lines);
        }
        catch { }
    }

    public async void OnToggleMinimizeToTray(object sender, RoutedEventArgs e)
    {
        bool current = await LoadMinimizeToTrayPreference();
        bool newVal = !current;
        SaveMinimizeToTrayPreference(newVal);
        UpdateMinimizeToTrayButton(newVal);
    }

    private async Task<bool> LoadRunAtStartupPreference()
    {
        try
        {
            string prefsFile = GetPreferencesFilePath();
            if (File.Exists(prefsFile))
            {
                var lines = await File.ReadAllLinesAsync(prefsFile);
                foreach (var line in lines)
                {
                    if (line.StartsWith("RunAtStartup="))
                    {
                        bool val = line.Substring(13).Trim() == "True";
                        UpdateRunAtStartupButton(val);
                        return val;
                    }
                }
            }
        }
        catch { }
        UpdateRunAtStartupButton(false);
        return false;
    }

    private void UpdateRunAtStartupButton(bool enabled)
    {
        RunAtStartupToggleButton.Content = $"Run at Startup: {(enabled ? "Enabled" : "Disabled")}";
        RunAtStartupToggleButton.Background = enabled ? 
            new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 122, 45)) : 
            new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(122, 45, 45));
    }

    private async void SaveRunAtStartupPreference(bool enabled)
    {
        try
        {
            string prefsFile = GetPreferencesFilePath();
            var lines = File.Exists(prefsFile) ? (await File.ReadAllLinesAsync(prefsFile)).ToList() : new List<string>();
            
            bool found = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("RunAtStartup="))
                {
                    lines[i] = "RunAtStartup=" + (enabled ? "True" : "False");
                    found = true;
                }
            }
            
            if (!found) lines.Add("RunAtStartup=" + (enabled ? "True" : "False"));
            
            await File.WriteAllLinesAsync(prefsFile, lines);
            
            // Apply to Windows Registry
            UpdateWindowsStartupRegistry(enabled);
        }
        catch { }
    }

    private void UpdateWindowsStartupRegistry(bool enabled)
    {
        try
        {
            const string runKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(runKey, true);
            if (key != null)
            {
                if (enabled)
                {
                    string exePath = Process.GetCurrentProcess().MainModule?.FileName ?? "";
                    if (!string.IsNullOrEmpty(exePath))
                    {
                        // Add --minimized flag so it starts in tray
                        key.SetValue("JadeBinEditor", $"\"{exePath}\" --minimized");
                    }
                }
                else
                {
                    key.DeleteValue("JadeBinEditor", false);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update Windows startup registry", ex);
        }
    }

    public async void OnToggleRunAtStartup(object sender, RoutedEventArgs e)
    {
        bool current = await LoadRunAtStartupPreference();
        bool newVal = !current;
        SaveRunAtStartupPreference(newVal);
        UpdateRunAtStartupButton(newVal);
    }
    
    // File Association Registration Methods
    private void OnRegisterBinAssociation(object sender, RoutedEventArgs e)
    {
        try
        {
            var exePath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            if (exePath == null)
            {
                MessageBox.Show("Could not determine application path.", "Error", 
                    MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
            
            // Create registry entries for .bin file association
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\.bin\OpenWithProgids"))
            {
                key?.SetValue("Jade.BinFile", "", Microsoft.Win32.RegistryValueKind.String);
            }
            
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\Jade.BinFile"))
            {
                key?.SetValue("", "Jade Bin File", Microsoft.Win32.RegistryValueKind.String);
            }
            
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\Jade.BinFile\shell\open\command"))
            {
                key?.SetValue("", $"\"{exePath}\" \"%1\"", Microsoft.Win32.RegistryValueKind.String);
            }
            
            // Add to Applications list for "Open with" menu
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Jade.exe\shell\open\command"))
            {
                key?.SetValue("", $"\"{exePath}\" \"%1\"", Microsoft.Win32.RegistryValueKind.String);
            }
            
            Logger.Info("Registered .bin file association");
            FileAssociationStatus.Text = "✓ Jade is registered as a .bin file handler. You can now right-click a .bin file and choose 'Open with' to select Jade.";
            FileAssociationStatus.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(76, 175, 80)); // Green
            
            MessageBox.Show(
                "Successfully registered Jade as a .bin file handler!\n\n" +
                "To open a .bin file with Jade:\n" +
                "1. Right-click a .bin file\n" +
                "2. Select 'Open with'\n" +
                "3. Choose 'Jade' from the list\n\n" +
                "Note: Jade is NOT set as the default handler.",
                "Registration Complete",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to register .bin file association", ex);
            FileAssociationStatus.Text = $"✗ Failed to register: {ex.Message}";
            FileAssociationStatus.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(255, 87, 87)); // Red
            
            MessageBox.Show($"Failed to register file association: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnUnregisterBinAssociation(object sender, RoutedEventArgs e)
    {
        try
        {
            // Remove registry entries
            try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Jade.BinFile", false); } catch { }
            try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\Jade.exe", false); } catch { }
            
            // Remove from OpenWithProgids
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\.bin\OpenWithProgids", true))
            {
                key?.DeleteValue("Jade.BinFile", false);
            }
            
            Logger.Info("Unregistered .bin file association");
            FileAssociationStatus.Text = "File association removed. Jade will no longer appear in the 'Open with' menu.";
            FileAssociationStatus.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(133, 133, 133)); // Gray
            
            MessageBox.Show(
                "Jade has been removed from the .bin file 'Open with' menu.",
                "Unregistration Complete",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to unregister .bin file association", ex);
            MessageBox.Show($"Failed to unregister: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void UpdateFileAssociationStatus()
    {
        try
        {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Classes\Jade.BinFile"))
            {
                if (key != null)
                {
                    FileAssociationStatus.Text = "✓ Jade is registered as a .bin file handler.";
                    FileAssociationStatus.Foreground = new System.Windows.Media.SolidColorBrush(
                        System.Windows.Media.Color.FromRgb(76, 175, 80)); // Green
                }
                else
                {
                    FileAssociationStatus.Text = "Jade is not registered. Click 'Register' to add Jade to the 'Open with' menu.";
                    FileAssociationStatus.Foreground = new System.Windows.Media.SolidColorBrush(
                        System.Windows.Media.Color.FromRgb(133, 133, 133)); // Gray
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to check file association status", ex);
        }
    }

    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            // Double-click to maximize/restore (optional)
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        }
        else
        {
            DragMove();
        }
    }

    private void OnRestart(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Restarting application");
            
            // Get the current executable path
            var exePath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            
            if (exePath != null)
            {
                // Start a new instance
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = exePath,
                    UseShellExecute = true
                });
                
                // Close the current instance
                Application.Current.Shutdown();
            }
            else
            {
                MessageBox.Show("Unable to restart the application. Please restart manually.", "Restart Failed",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to restart application", ex);
            MessageBox.Show($"Failed to restart: {ex.Message}\n\nPlease restart the application manually.", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private string GetCurrentTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            return line.Substring(6).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return "Default";
    }
    
    private void ApplyWindowTheme(string theme)
    {
        try
        {
            System.Windows.Media.SolidColorBrush bgColor, titleBarBg, textColor;
            
            if (theme == "DarkBlue")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 30, 45));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 35, 50));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 230, 240));
            }
            else if (theme == "DarkRed")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 20, 25));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 30));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(240, 220, 225));
            }
            else if (theme == "LightPink")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 165, 190));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 130, 160));
                textColor = System.Windows.Media.Brushes.Black; // Darker text for light theme
            }
            else if (theme == "PastelBlue")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 240, 255));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 240, 250));
                textColor = System.Windows.Media.Brushes.Black; // Darker text for light theme
            }
            else if (theme == "ForestGreen")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 45, 30));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 50, 35));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(200, 230, 210));
            }
            else if (theme == "AMOLED")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(10, 10, 10));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 180, 180));
            }
            else if (theme == "Void")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(15, 10, 30));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 15, 40));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 170, 220));
            }
            else if (theme == "VioletSorrow")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 12, 42));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(28, 18, 52));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(185, 170, 215));
            }
            else // Default
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 30, 30));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(37, 37, 38));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(212, 212, 212));
            }
            
            this.Background = bgColor;
            
            // Update title bar
            var titleBar = this.FindName("TitleBar") as System.Windows.Controls.Border;
            if (titleBar != null)
            {
                titleBar.Background = titleBarBg;
            }
            
            // Update boxes (HashFilesBox, TempFilesBox, AppBehaviorBox)
            var boxes = new[] { "HashFilesBox", "TempFilesBox", "AppBehaviorBox" };
            foreach (var boxName in boxes)
            {
                if (this.FindName(boxName) is System.Windows.Controls.Border box)
                {
                    box.Background = titleBarBg; // Use title bar color for boxes (consistent with ThemesWindow)
                    box.BorderBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 255, 255, 255)); // Subtle light border
                }
            }
            
            // Update all TextBlocks
            UpdateTextBlockColors(this, textColor);
            
            // Update all separators
            UpdateSeparatorColors(this, new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(30, 255, 255, 255)));
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply window theme", ex);
        }
    }
    
    private void UpdateSeparatorColors(System.Windows.DependencyObject parent, System.Windows.Media.SolidColorBrush color)
    {
        int childCount = System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is System.Windows.Controls.Separator separator)
            {
                separator.Background = color;
            }
            UpdateSeparatorColors(child, color);
        }
    }
    
    private void UpdateTextBlockColors(System.Windows.DependencyObject parent, System.Windows.Media.SolidColorBrush color)
    {
        int childCount = System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is System.Windows.Controls.TextBlock textBlock)
            {
                textBlock.Foreground = color;
            }
            UpdateTextBlockColors(child, color);
        }
    }
}
