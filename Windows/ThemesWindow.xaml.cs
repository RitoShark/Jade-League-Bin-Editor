using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Jade.Services;

namespace Jade.Windows;

public partial class ThemesWindow : Window
{
    private string _currentTheme = "Default";
    public System.Collections.ObjectModel.ObservableCollection<ThemeItem> Themes { get; set; } = new();
    public System.Collections.ObjectModel.ObservableCollection<BracketThemeItem> BracketThemes { get; set; } = new();

    public class ThemeItem
    {
        public string Id { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public System.Windows.Media.SolidColorBrush Background { get; set; } = System.Windows.Media.Brushes.Transparent;
        public System.Windows.Media.SolidColorBrush EditorBackground { get; set; } = System.Windows.Media.Brushes.Transparent;
        public System.Windows.Media.SolidColorBrush TitleBarBackground { get; set; } = System.Windows.Media.Brushes.Transparent;
        public System.Windows.Media.SolidColorBrush StatusBarBackground { get; set; } = System.Windows.Media.Brushes.Transparent;
        public System.Windows.Media.SolidColorBrush Foreground { get; set; } = System.Windows.Media.Brushes.White;
        public System.Windows.Media.SolidColorBrush TabBackground { get; set; } = System.Windows.Media.Brushes.Transparent;
        public System.Windows.Media.SolidColorBrush SelectedTabBackground { get; set; } = System.Windows.Media.Brushes.Transparent;
    }

    public class BracketThemeItem
    {
        public string Id { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public System.Windows.Media.SolidColorBrush PreviewColor1 { get; set; } = System.Windows.Media.Brushes.Gold;
        public System.Windows.Media.SolidColorBrush PreviewColor2 { get; set; } = System.Windows.Media.Brushes.Orchid;
        public System.Windows.Media.SolidColorBrush PreviewColor3 { get; set; } = System.Windows.Media.Brushes.DeepSkyBlue;
        
        // Full syntax colors for preview
        public System.Windows.Media.SolidColorBrush KeywordColor { get; set; } = System.Windows.Media.Brushes.DodgerBlue;
        public System.Windows.Media.SolidColorBrush CommentColor { get; set; } = System.Windows.Media.Brushes.Gray;
        public System.Windows.Media.SolidColorBrush StringColor { get; set; } = System.Windows.Media.Brushes.Orange;
        public System.Windows.Media.SolidColorBrush NumberColor { get; set; } = System.Windows.Media.Brushes.LightBlue;
        public System.Windows.Media.SolidColorBrush PropertyColor { get; set; } = System.Windows.Media.Brushes.DodgerBlue;
    }
    
    public ThemesWindow()
    {
        InitializeComponent();
        
        // Initialize themes
        InitializeThemes();
        InitializeBracketThemes();
        
        // Load theme preferences
        LoadThemePreference();
        
        // Apply current theme to this window
        ApplyWindowTheme(_currentTheme);
        
        // Set DataContext for binding
        this.DataContext = this;
        
        Logger.Info("Themes window opened");
    }

    private void InitializeThemes()
    {
        Themes.Add(new ThemeItem { 
            Id = "Default", DisplayName = "Dark Emptiness", 
            Background = GetBrush(30, 30, 30), EditorBackground = GetBrush(30, 30, 30), 
            TitleBarBackground = GetBrush(37, 37, 38), StatusBarBackground = GetBrush(80, 80, 80),
            Foreground = GetBrush(212, 212, 212), TabBackground = GetBrush(37, 37, 38),
            SelectedTabBackground = GetBrush(62, 62, 66)
        });
        Themes.Add(new ThemeItem { 
            Id = "DarkBlue", DisplayName = "Blue Guilt", 
            Background = GetBrush(15, 25, 40), EditorBackground = GetBrush(20, 30, 45), 
            TitleBarBackground = GetBrush(25, 35, 50), StatusBarBackground = GetBrush(0, 90, 158),
            Foreground = GetBrush(220, 230, 240), TabBackground = GetBrush(25, 35, 50),
            SelectedTabBackground = GetBrush(45, 65, 90)
        });
        Themes.Add(new ThemeItem { 
            Id = "DarkRed", DisplayName = "Red Regret", 
            Background = GetBrush(40, 15, 20), EditorBackground = GetBrush(45, 20, 25), 
            TitleBarBackground = GetBrush(50, 25, 30), StatusBarBackground = GetBrush(158, 0, 40),
            Foreground = GetBrush(240, 220, 225), TabBackground = GetBrush(50, 25, 30),
            SelectedTabBackground = GetBrush(90, 45, 55)
        });
        Themes.Add(new ThemeItem { 
            Id = "LightPink", DisplayName = "Pink Remembrance", 
            Background = GetBrush(200, 150, 180), EditorBackground = GetBrush(210, 165, 190), 
            TitleBarBackground = GetBrush(180, 130, 160), StatusBarBackground = GetBrush(199, 21, 133),
            Foreground = System.Windows.Media.Brushes.Black, TabBackground = GetBrush(180, 130, 160),
            SelectedTabBackground = GetBrush(230, 150, 190)
        });
        Themes.Add(new ThemeItem { 
            Id = "PastelBlue", DisplayName = "Primo", 
            Background = GetBrush(230, 245, 255), EditorBackground = GetBrush(210, 240, 255), 
            TitleBarBackground = GetBrush(255, 240, 250), StatusBarBackground = GetBrush(80, 200, 255),
            Foreground = System.Windows.Media.Brushes.Black, TabBackground = GetBrush(235, 225, 255),
            SelectedTabBackground = GetBrush(160, 230, 255)
        });
        Themes.Add(new ThemeItem { 
            Id = "ForestGreen", DisplayName = "Green Nostalgia", 
            Background = GetBrush(20, 35, 25), EditorBackground = GetBrush(25, 45, 30), 
            TitleBarBackground = GetBrush(30, 50, 35), StatusBarBackground = GetBrush(34, 139, 34),
            Foreground = GetBrush(200, 230, 210), TabBackground = GetBrush(30, 50, 35),
            SelectedTabBackground = GetBrush(50, 85, 60)
        });
        Themes.Add(new ThemeItem { 
            Id = "AMOLED", DisplayName = "AMOLED", 
            Background = GetBrush(0, 0, 0), EditorBackground = GetBrush(0, 0, 0), 
            TitleBarBackground = GetBrush(10, 10, 10), StatusBarBackground = GetBrush(20, 20, 20),
            Foreground = GetBrush(180, 180, 180), TabBackground = GetBrush(10, 10, 10),
            SelectedTabBackground = GetBrush(30, 30, 30)
        });
        Themes.Add(new ThemeItem { 
            Id = "Void", DisplayName = "Purple Void", 
            Background = GetBrush(10, 5, 20), EditorBackground = GetBrush(15, 10, 30), 
            TitleBarBackground = GetBrush(20, 15, 40), StatusBarBackground = GetBrush(25, 15, 80),
            Foreground = GetBrush(180, 170, 220), TabBackground = GetBrush(20, 15, 40),
            SelectedTabBackground = GetBrush(40, 30, 70)
        });
        Themes.Add(new ThemeItem { 
            Id = "VioletSorrow", DisplayName = "Violet Sorrow", 
            Background = GetBrush(18, 10, 35), EditorBackground = GetBrush(22, 12, 42), 
            TitleBarBackground = GetBrush(28, 18, 52), StatusBarBackground = GetBrush(65, 30, 120),
            Foreground = GetBrush(185, 170, 215), TabBackground = GetBrush(32, 20, 58),
            SelectedTabBackground = GetBrush(75, 50, 115)
        });
    }

    private void InitializeBracketThemes()
    {
        // Add all themes as bracket theme options
        foreach (var theme in Themes)
        {
            var syntaxColors = GetFullSyntaxColors(theme.Id);
            BracketThemes.Add(new BracketThemeItem {
                Id = theme.Id,
                DisplayName = theme.DisplayName,
                PreviewColor1 = GetBracketPreviewColor(theme.Id, 0),
                PreviewColor2 = GetBracketPreviewColor(theme.Id, 1),
                PreviewColor3 = GetBracketPreviewColor(theme.Id, 2),
                KeywordColor = GetBrushFromHex(syntaxColors.keyword),
                CommentColor = GetBrushFromHex(syntaxColors.comment),
                StringColor = GetBrushFromHex(syntaxColors.stringColor),
                NumberColor = GetBrushFromHex(syntaxColors.number),
                PropertyColor = GetBrushFromHex(syntaxColors.propertyColor)
            });
        }
        
        // Add a High Contrast option specifically for brackets
        var hcColors = GetFullSyntaxColors("HighContrast");
        BracketThemes.Add(new BracketThemeItem {
            Id = "HighContrast", DisplayName = "High Contrast",
            PreviewColor1 = GetBrush(255, 255, 0), PreviewColor2 = GetBrush(0, 255, 0), PreviewColor3 = GetBrush(255, 0, 0),
            KeywordColor = GetBrushFromHex(hcColors.keyword),
            CommentColor = GetBrushFromHex(hcColors.comment),
            StringColor = GetBrushFromHex(hcColors.stringColor),
            NumberColor = GetBrushFromHex(hcColors.number),
            PropertyColor = GetBrushFromHex(hcColors.propertyColor)
        });

        // Add VS Code as a standalone syntax theme
        var vscodeColors = GetFullSyntaxColors("VSCode");
        BracketThemes.Add(new BracketThemeItem {
            Id = "VSCode", DisplayName = "VS Code",
            PreviewColor1 = GetBrush(255, 215, 0), PreviewColor2 = GetBrush(218, 112, 214), PreviewColor3 = GetBrush(23, 159, 255),
            KeywordColor = GetBrushFromHex(vscodeColors.keyword),
            CommentColor = GetBrushFromHex(vscodeColors.comment),
            StringColor = GetBrushFromHex(vscodeColors.stringColor),
            NumberColor = GetBrushFromHex(vscodeColors.number),
            PropertyColor = GetBrushFromHex(vscodeColors.propertyColor)
        });
    }

    private (string keyword, string comment, string stringColor, string number, string propertyColor) GetFullSyntaxColors(string themeId)
    {
        return themeId switch
        {
            "DarkBlue" => ("#5DADE2", "#52BE80", "#F39C12", "#AED6F1", "#5DADE2"),
            "DarkRed" => ("#EC7063", "#82E0AA", "#F8C471", "#F1948A", "#EC7063"),
            "LightPink" => ("#7D3C98", "#1E8449", "#BA4A00", "#6C3483", "#7D3C98"),
            "PastelBlue" => ("#2874A6", "#117A65", "#D68910", "#1F618D", "#2874A6"),
            "ForestGreen" => ("#85C1E9", "#52BE80", "#F39C12", "#AED6F1", "#85C1E9"),
            "AMOLED" => ("#5DADE2", "#52BE80", "#F39C12", "#AED6F1", "#5DADE2"),
            "Void" => ("#BB8FCE", "#82E0AA", "#F8C471", "#D7BDE2", "#BB8FCE"),
            "VioletSorrow" => ("#9B7EDE", "#7EC8A3", "#E8A87C", "#C8A2E0", "#9B7EDE"),
            "HighContrast" => ("#FFFF00", "#00FF00", "#FF00FF", "#00FFFF", "#FFFF00"),
            "VSCode" => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#9CDCFE"),
            _ => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#569CD6")
        };
    }

    private System.Windows.Media.SolidColorBrush GetBrushFromHex(string hex)
    {
        try {
            return (System.Windows.Media.SolidColorBrush)new System.Windows.Media.BrushConverter().ConvertFrom(hex);
        } catch {
            return System.Windows.Media.Brushes.Gray;
        }
    }

    private System.Windows.Media.SolidColorBrush GetBracketPreviewColor(string themeId, int index)
    {
        // Hardcoded preview colors for the listbox swatches based on the renderer logic
        return themeId switch
        {
            "DarkBlue" => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(218, 112, 214) : GetBrush(0, 191, 255),
            "DarkRed" => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(255, 105, 180) : GetBrush(255, 140, 0),
            "LightPink" => index == 0 ? GetBrush(75, 0, 130) : index == 1 ? GetBrush(138, 43, 226) : GetBrush(148, 0, 211),
            "PastelBlue" => index == 0 ? GetBrush(184, 134, 11) : index == 1 ? GetBrush(139, 0, 139) : GetBrush(0, 100, 0),
            "ForestGreen" => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(64, 224, 208) : GetBrush(173, 255, 47),
            "AMOLED" => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(0, 255, 255) : GetBrush(255, 0, 255),
            "Void" => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(186, 85, 211) : GetBrush(138, 43, 226),
            "VioletSorrow" => index == 0 ? GetBrush(147, 112, 219) : index == 1 ? GetBrush(138, 43, 226) : GetBrush(186, 85, 211),
            _ => index == 0 ? GetBrush(255, 215, 0) : index == 1 ? GetBrush(218, 112, 214) : GetBrush(135, 206, 250) // Default/Classic
        };
    }

    private System.Windows.Media.SolidColorBrush GetBrush(byte r, byte g, byte b)
    {
        return new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(r, g, b));
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
            
            // Select the current theme in the ListBox
            var selectedTheme = Themes.FirstOrDefault(t => t.Id == theme);
            if (selectedTheme != null)
            {
                ThemesListBox.SelectedItem = selectedTheme;
            }
            
            // Load bracket theme
            string bracketTheme = "Classic";
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("BracketTheme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.Trim().StartsWith("BracketTheme="))
                        {
                            bracketTheme = line.Substring(13).Trim();
                            break;
                        }
                    }
                }
            }
            
            var selectedBracketTheme = BracketThemes.FirstOrDefault(t => t.Id == bracketTheme);
            if (selectedBracketTheme != null)
            {
                BracketThemesListBox.SelectedItem = selectedBracketTheme;
            }
            
            // Override toggle
            bool overrideBrackets = false;
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                overrideBrackets = content.Contains("OverrideBracketTheme=True");
            }
            OverrideBracketsCheckBox.IsChecked = overrideBrackets;
            
            UpdateCurrentThemeText();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load theme preference", ex);
        }
    }
    
    private void OnThemeSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ThemesListBox.SelectedItem is ThemeItem selectedTheme)
        {
            _currentTheme = selectedTheme.Id;
            UpdatePalettePreview(selectedTheme);
            UpdateCurrentThemeText();
            
            // If override is off, sync bracket selection
            if (OverrideBracketsCheckBox.IsChecked != true)
            {
                var matchingBracketTheme = BracketThemes.FirstOrDefault(t => t.Id == selectedTheme.Id);
                if (matchingBracketTheme != null)
                {
                    BracketThemesListBox.SelectedItem = matchingBracketTheme;
                }
            }
        }
    }

    private void OnOverrideChecked(object sender, RoutedEventArgs e)
    {
        if (OverrideBracketsCheckBox.IsChecked != true)
        {
            // Sync immediately when unchecking
            if (ThemesListBox.SelectedItem is ThemeItem selectedTheme)
            {
                var matchingBracketTheme = BracketThemes.FirstOrDefault(t => t.Id == selectedTheme.Id);
                if (matchingBracketTheme != null)
                {
                    BracketThemesListBox.SelectedItem = matchingBracketTheme;
                }
            }
        }
    }

    private void OnBracketThemeSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // Preview is handled by XAML binding to SelectedItem
    }

    private void UpdatePalettePreview(ThemeItem theme)
    {
        var palette = new System.Collections.Generic.List<ColorPreviewItem>
        {
            new ColorPreviewItem { Label = "Window Background", Color = theme.Background },
            new ColorPreviewItem { Label = "Editor Background", Color = theme.EditorBackground },
            new ColorPreviewItem { Label = "Title Bar", Color = theme.TitleBarBackground },
            new ColorPreviewItem { Label = "Status Bar", Color = theme.StatusBarBackground },
            new ColorPreviewItem { Label = "Foreground Text", Color = theme.Foreground },
            new ColorPreviewItem { Label = "Tab Background", Color = theme.TabBackground },
            new ColorPreviewItem { Label = "Selected Tab", Color = theme.SelectedTabBackground }
        };
        
        ColorPaletteList.ItemsSource = palette;
    }

    public class ColorPreviewItem
    {
        public string Label { get; set; } = "";
        public System.Windows.Media.SolidColorBrush Color { get; set; } = System.Windows.Media.Brushes.Transparent;
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
    
    // Old handlers removed
    
    private void SavePreferences(string theme, string bracketTheme, bool overrideBrackets)
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
                    if (!line.Trim().StartsWith("Theme=") && 
                        !line.Trim().StartsWith("BracketTheme=") && 
                        !line.Trim().StartsWith("OverrideBracketTheme="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            lines.Add($"Theme={theme}");
            lines.Add($"BracketTheme={bracketTheme}");
            lines.Add($"OverrideBracketTheme={overrideBrackets}");
            
            var directory = Path.GetDirectoryName(prefsFile);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved preferences: Theme={theme}, BracketTheme={bracketTheme}, Override={overrideBrackets}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save preferences", ex);
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
            if (ThemesListBox.SelectedItem is ThemeItem selectedTheme && 
                BracketThemesListBox.SelectedItem is BracketThemeItem selectedBracketTheme)
            {
                bool overrideBrackets = OverrideBracketsCheckBox.IsChecked == true;
                SavePreferences(selectedTheme.Id, selectedBracketTheme.Id, overrideBrackets);
                ApplyTheme(selectedTheme.Id);
                
                // Refresh this window's theme immediately
                ApplyWindowTheme(selectedTheme.Id);
                UpdatePalettePreview(selectedTheme);
                UpdateCurrentThemeText();
                
                var mainWindow = Application.Current.MainWindow as MainWindow;
                if (mainWindow != null)
                {
                    mainWindow.LoadTheme();
                    Logger.Info($"Applied preferences: Theme={selectedTheme.Id}, BracketTheme={selectedBracketTheme.Id}, Override={overrideBrackets}");
                    MessageBox.Show("Settings applied successfully!", "Applied", MessageBoxButton.OK, MessageBoxImage.Information);
                }
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
            var themeItem = Themes.FirstOrDefault(t => t.Id == theme) ?? Themes.FirstOrDefault(t => t.Id == "Default");
            if (themeItem == null) return;

            var bgColor = themeItem.EditorBackground; // Using EditorBackground as per user request (was darker than intended)
            var titleBarBg = themeItem.TitleBarBackground;
            var textColor = themeItem.Foreground;
            
            this.Background = bgColor;
            
            // Update title bar
            var titleBar = this.FindName("TitleBar") as System.Windows.Controls.Border;
            if (titleBar != null)
            {
                titleBar.Background = titleBarBg;
            }

            // Update ListBox and Preview Panel backgrounds to follow theme
            var listBox = this.FindName("ThemesListBox") as System.Windows.Controls.ListBox;
            if (listBox != null)
            {
                listBox.Background = bgColor;
                listBox.BorderBrush = titleBarBg;
            }

            var syntaxListBox = this.FindName("BracketThemesListBox") as System.Windows.Controls.ListBox;
            if (syntaxListBox != null)
            {
                syntaxListBox.Background = bgColor;
                syntaxListBox.BorderBrush = titleBarBg;
            }

            var previewPanelBorder = this.FindName("PreviewPanelBorder") as System.Windows.Controls.Border;
            if (previewPanelBorder != null)
            {
                previewPanelBorder.Background = bgColor;
                previewPanelBorder.BorderBrush = titleBarBg;
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
