using System;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Jade.Services;

namespace Jade.Windows;

public partial class ThemesWindow : Window
{
    private string _currentTheme = "Default";
    
    public ThemesWindow()
    {
        InitializeComponent();
        
        // Load theme preference
        LoadThemePreference();
        
        // Apply current theme to this window
        ApplyWindowTheme(_currentTheme);
        
        Logger.Info("Themes window opened");
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        }
        else
        {
            DragMove();
        }
    }
    
    private void LoadThemePreference()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            string theme = "Default";
            
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
                            theme = line.Substring(6).Trim();
                            break;
                        }
                    }
                }
            }
            
            _currentTheme = theme;
            UpdateThemeButtons(theme);
            UpdateCurrentThemeText();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load theme preference", ex);
        }
    }
    
    private void UpdateThemeButtons(string theme)
    {
        var whiteBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Colors.White);
        var transparentBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Colors.Transparent);
        
        // Reset all buttons to their theme colors with no border
        Theme1Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 60, 60));
        Theme1Button.BorderBrush = transparentBrush;
        Theme1Button.BorderThickness = new Thickness(0);
        
        Theme2Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 58, 95));
        Theme2Button.BorderBrush = transparentBrush;
        Theme2Button.BorderThickness = new Thickness(0);
        
        Theme3Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(95, 30, 30));
        Theme3Button.BorderBrush = transparentBrush;
        Theme3Button.BorderThickness = new Thickness(0);
        
        Theme4Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(232, 180, 212));
        Theme4Button.BorderBrush = transparentBrush;
        Theme4Button.BorderThickness = new Thickness(0);
        
        Theme5Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 240, 255));
        Theme5Button.BorderBrush = transparentBrush;
        Theme5Button.BorderThickness = new Thickness(0);
        
        Theme6Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 95, 63));
        Theme6Button.BorderBrush = transparentBrush;
        Theme6Button.BorderThickness = new Thickness(0);
        
        Theme7Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0));
        Theme7Button.BorderBrush = transparentBrush;
        Theme7Button.BorderThickness = new Thickness(0);
        
        Theme8Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(26, 15, 46));
        Theme8Button.BorderBrush = transparentBrush;
        Theme8Button.BorderThickness = new Thickness(0);
        
        Theme9Button.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(46, 26, 71));
        Theme9Button.BorderBrush = transparentBrush;
        Theme9Button.BorderThickness = new Thickness(0);
        
        // Add white outline to selected theme
        if (theme == "Default")
        {
            Theme1Button.BorderBrush = whiteBrush;
            Theme1Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "DarkBlue")
        {
            Theme2Button.BorderBrush = whiteBrush;
            Theme2Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "DarkRed")
        {
            Theme3Button.BorderBrush = whiteBrush;
            Theme3Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "LightPink")
        {
            Theme4Button.BorderBrush = whiteBrush;
            Theme4Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "PastelBlue")
        {
            Theme5Button.BorderBrush = whiteBrush;
            Theme5Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "ForestGreen")
        {
            Theme6Button.BorderBrush = whiteBrush;
            Theme6Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "AMOLED")
        {
            Theme7Button.BorderBrush = whiteBrush;
            Theme7Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "Void")
        {
            Theme8Button.BorderBrush = whiteBrush;
            Theme8Button.BorderThickness = new Thickness(3);
        }
        else if (theme == "VioletSorrow")
        {
            Theme9Button.BorderBrush = whiteBrush;
            Theme9Button.BorderThickness = new Thickness(3);
        }
    }
    
    private void UpdateCurrentThemeText()
    {
        string displayName = _currentTheme switch
        {
            "Default" => "Dark Emptiness",
            "DarkBlue" => "Blue Guilt",
            "DarkRed" => "Red Regret",
            "LightPink" => "Pink Remembrance",
            "PastelBlue" => "Primo",
            "ForestGreen" => "Green Nostalgia",
            "AMOLED" => "AMOLED",
            "Void" => "Purple Void",
            "VioletSorrow" => "Violet Sorrow",
            _ => "Unknown"
        };
        
        CurrentThemeText.Text = $"Current Theme: {displayName}";
    }
    
    private void OnTheme1(object sender, RoutedEventArgs e)
    {
        _currentTheme = "Default";
        SaveThemePreference("Default");
        UpdateThemeButtons("Default");
        UpdateCurrentThemeText();
        ApplyTheme("Default");
    }
    
    private void OnTheme2(object sender, RoutedEventArgs e)
    {
        _currentTheme = "DarkBlue";
        SaveThemePreference("DarkBlue");
        UpdateThemeButtons("DarkBlue");
        UpdateCurrentThemeText();
        ApplyTheme("DarkBlue");
    }
    
    private void OnTheme3(object sender, RoutedEventArgs e)
    {
        _currentTheme = "DarkRed";
        SaveThemePreference("DarkRed");
        UpdateThemeButtons("DarkRed");
        UpdateCurrentThemeText();
        ApplyTheme("DarkRed");
    }
    
    private void OnTheme4(object sender, RoutedEventArgs e)
    {
        _currentTheme = "LightPink";
        SaveThemePreference("LightPink");
        UpdateThemeButtons("LightPink");
        UpdateCurrentThemeText();
        ApplyTheme("LightPink");
    }
    
    private void OnTheme5(object sender, RoutedEventArgs e)
    {
        _currentTheme = "PastelBlue";
        SaveThemePreference("PastelBlue");
        UpdateThemeButtons("PastelBlue");
        UpdateCurrentThemeText();
        ApplyTheme("PastelBlue");
    }
    
    private void OnTheme6(object sender, RoutedEventArgs e)
    {
        _currentTheme = "ForestGreen";
        SaveThemePreference("ForestGreen");
        UpdateThemeButtons("ForestGreen");
        UpdateCurrentThemeText();
        ApplyTheme("ForestGreen");
    }
    
    private void OnTheme7(object sender, RoutedEventArgs e)
    {
        _currentTheme = "AMOLED";
        SaveThemePreference("AMOLED");
        UpdateThemeButtons("AMOLED");
        UpdateCurrentThemeText();
        ApplyTheme("AMOLED");
    }
    
    private void OnTheme8(object sender, RoutedEventArgs e)
    {
        _currentTheme = "Void";
        SaveThemePreference("Void");
        UpdateThemeButtons("Void");
        UpdateCurrentThemeText();
        ApplyTheme("Void");
    }
    
    private void OnTheme9(object sender, RoutedEventArgs e)
    {
        _currentTheme = "VioletSorrow";
        SaveThemePreference("VioletSorrow");
        UpdateThemeButtons("VioletSorrow");
        UpdateCurrentThemeText();
        ApplyTheme("VioletSorrow");
    }
    
    private void SaveThemePreference(string theme)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new System.Collections.Generic.List<string>();
            
            if (File.Exists(prefsFile))
            {
                var existingLines = File.ReadAllLines(prefsFile);
                foreach (var line in existingLines)
                {
                    if (!line.StartsWith("Theme="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            lines.Add($"Theme={theme}");
            
            var directory = Path.GetDirectoryName(prefsFile);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved theme preference: {theme}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save theme preference", ex);
        }
    }
    
    private void ApplyTheme(string theme)
    {
        try
        {
            var mainWindow = Application.Current.MainWindow as MainWindow;
            if (mainWindow != null)
            {
                mainWindow.ApplyTheme(theme);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply theme", ex);
        }
    }
    
    private string GetPreferencesFilePath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var prefsFolder = Path.Combine(appDataPath, "RitoShark", "Jade");
        
        if (!Directory.Exists(prefsFolder))
        {
            Directory.CreateDirectory(prefsFolder);
        }
        
        return Path.Combine(prefsFolder, "preferences.txt");
    }
    
    private void OnApplyTheme(object sender, RoutedEventArgs e)
    {
        try
        {
            var mainWindow = Application.Current.MainWindow as MainWindow;
            if (mainWindow != null)
            {
                // Reload theme on main window
                var theme = _currentTheme;
                mainWindow.LoadTheme();
                
                Logger.Info($"Applied theme: {theme}");
                MessageBox.Show("Theme applied successfully!", "Theme Applied", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply theme", ex);
            MessageBox.Show("Failed to apply theme. Please try again.", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
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
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 15, 25)); // Darker text for light theme
            }
            else if (theme == "PastelBlue")
            {
                bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 240, 255));
                titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 240, 250));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 25, 60)); // Darker text for light theme
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
            
            // Update all TextBlocks
            UpdateTextBlockColors(this, textColor);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply window theme", ex);
        }
    }
    
    private void UpdateTextBlockColors(System.Windows.DependencyObject parent, System.Windows.Media.SolidColorBrush color)
    {
        int childCount = System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(parent, i);
            if (child is System.Windows.Controls.TextBlock textBlock && textBlock.Name != "TitleText")
            {
                textBlock.Foreground = color;
            }
            UpdateTextBlockColors(child, color);
        }
    }
}
