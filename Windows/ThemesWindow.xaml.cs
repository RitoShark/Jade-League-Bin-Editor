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
        Jade.Services.IconService.ApplyIconToWindow(this);
        
        // Initialize themes
        InitializeThemes();
        InitializeBracketThemes();
        
        // Load theme preferences
        LoadThemePreference();
        
        // Load custom theme settings
        LoadCustomThemeSettings();
        
        // Update initial preview
        if (ThemesListBox.SelectedItem is ThemeItem selectedTheme)
        {
            UpdatePalettePreview(selectedTheme);
        }
        else if (UseCustomThemeCheckBox?.IsChecked == true)
        {
            UpdatePalettePreview(null!);
        }

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
        Themes.Add(new ThemeItem { 
            Id = "OrangeBurnout", DisplayName = "Orange Burnout", 
            Background = GetBrush(35, 15, 5), EditorBackground = GetBrush(42, 20, 8), 
            TitleBarBackground = GetBrush(50, 25, 10), StatusBarBackground = GetBrush(204, 85, 0),
            Foreground = GetBrush(255, 228, 209), TabBackground = GetBrush(50, 25, 10),
            SelectedTabBackground = GetBrush(110, 45, 15)
        });
        Themes.Add(new ThemeItem { 
            Id = "PurpleGrief", DisplayName = "Purple Grief", 
            Background = GetBrush(25, 15, 30), EditorBackground = GetBrush(30, 20, 35), 
            TitleBarBackground = GetBrush(35, 25, 40), StatusBarBackground = GetBrush(70, 40, 80),
            Foreground = GetBrush(220, 200, 230), TabBackground = GetBrush(35, 25, 40),
            SelectedTabBackground = GetBrush(80, 50, 90)
        });
    }

    private void InitializeBracketThemes()
    {
        // Add all themes as bracket theme options
        foreach (var theme in Themes)
        {
            var syntaxColors = GetFullSyntaxColors(theme.Id);
            var bColors = Jade.Services.ThemeHelper.GetBracketColors(theme.Id);
            BracketThemes.Add(new BracketThemeItem {
                Id = theme.Id,
                DisplayName = theme.DisplayName,
                PreviewColor1 = new System.Windows.Media.SolidColorBrush(bColors[0]),
                PreviewColor2 = new System.Windows.Media.SolidColorBrush(bColors[1]),
                PreviewColor3 = new System.Windows.Media.SolidColorBrush(bColors[2]),
                KeywordColor = GetBrushFromHex(syntaxColors.keyword),
                CommentColor = GetBrushFromHex(syntaxColors.comment),
                StringColor = GetBrushFromHex(syntaxColors.stringColor),
                NumberColor = GetBrushFromHex(syntaxColors.number),
                PropertyColor = GetBrushFromHex(syntaxColors.propertyColor)
            });
        }
        
        // Add a High Contrast option specifically for brackets
        var hcColors = GetFullSyntaxColors("HighContrast");
        var hcBColors = Jade.Services.ThemeHelper.GetBracketColors("HighContrast");
        BracketThemes.Add(new BracketThemeItem {
            Id = "HighContrast", DisplayName = "High Contrast",
            PreviewColor1 = new System.Windows.Media.SolidColorBrush(hcBColors[0]), 
            PreviewColor2 = new System.Windows.Media.SolidColorBrush(hcBColors[1]), 
            PreviewColor3 = new System.Windows.Media.SolidColorBrush(hcBColors[2]),
            KeywordColor = GetBrushFromHex(hcColors.keyword),
            CommentColor = GetBrushFromHex(hcColors.comment),
            StringColor = GetBrushFromHex(hcColors.stringColor),
            NumberColor = GetBrushFromHex(hcColors.number),
            PropertyColor = GetBrushFromHex(hcColors.propertyColor)
        });

        // Add VS Code as a standalone syntax theme
        var vscodeColors = GetFullSyntaxColors("VSCode");
        var vscodeBColors = Jade.Services.ThemeHelper.GetBracketColors("VSCode");
        BracketThemes.Add(new BracketThemeItem {
            Id = "VSCode", DisplayName = "VS Code",
            PreviewColor1 = new System.Windows.Media.SolidColorBrush(vscodeBColors[0]), 
            PreviewColor2 = new System.Windows.Media.SolidColorBrush(vscodeBColors[1]), 
            PreviewColor3 = new System.Windows.Media.SolidColorBrush(vscodeBColors[2]),
            KeywordColor = GetBrushFromHex(vscodeColors.keyword),
            CommentColor = GetBrushFromHex(vscodeColors.comment),
            StringColor = GetBrushFromHex(vscodeColors.stringColor),
            NumberColor = GetBrushFromHex(vscodeColors.number),
            PropertyColor = GetBrushFromHex(vscodeColors.propertyColor)
        });

        // Add Standard Flint as a standalone syntax theme (matches Monaco ritobin theme)
        var flintColors = GetFullSyntaxColors("StandardFlint");
        var flintBColors = Jade.Services.ThemeHelper.GetBracketColors("StandardFlint");
        BracketThemes.Add(new BracketThemeItem {
            Id = "StandardFlint", DisplayName = "Standard Flint",
            PreviewColor1 = new System.Windows.Media.SolidColorBrush(flintBColors[0]), 
            PreviewColor2 = new System.Windows.Media.SolidColorBrush(flintBColors[1]), 
            PreviewColor3 = new System.Windows.Media.SolidColorBrush(flintBColors[2]),
            KeywordColor = GetBrushFromHex(flintColors.keyword),
            CommentColor = GetBrushFromHex(flintColors.comment),
            StringColor = GetBrushFromHex(flintColors.stringColor),
            NumberColor = GetBrushFromHex(flintColors.number),
            PropertyColor = GetBrushFromHex(flintColors.propertyColor)
        });
    }

    public static (string keyword, string comment, string stringColor, string number, string propertyColor) GetFullSyntaxColors(string themeId)
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
            "OrangeBurnout" => ("#FF8C00", "#8B4513", "#FFD700", "#F4A460", "#FFA07A"),
            "PurpleGrief" => ("#BE9FE1", "#6F4E7C", "#E1BEE7", "#9575CD", "#B39DDB"),
            // Standard Flint - matches Monaco Editor ritobin theme colors
            "StandardFlint" => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#DCDCAA"),
            // Default fallback (also used for "Default" theme)
            _ => ("#569CD6", "#6A9955", "#CE9178", "#B5CEA8", "#569CD6")
        };
    }

    private System.Windows.Media.SolidColorBrush GetBrushFromHex(string hex)
    {
        try {
            var brush = new System.Windows.Media.BrushConverter().ConvertFrom(hex) as System.Windows.Media.SolidColorBrush;
            return brush ?? System.Windows.Media.Brushes.Gray;
        } catch {
            return System.Windows.Media.Brushes.Gray;
        }
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

            // Rounded Corners
            bool roundedEdges = false;
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                roundedEdges = content.Contains("RoundedEdges=True");
            }
            if (this.FindName("RoundedCornersCheckBox") is CheckBox roundedCb)
            {
                roundedCb.IsChecked = roundedEdges;
            }

            // Custom Theme
        LoadCustomThemeSettings();
        bool useCustomTheme = false;
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                useCustomTheme = content.Contains("UseCustomTheme=True");
            }
            UseCustomThemeCheckBox.IsChecked = useCustomTheme;
            if (useCustomTheme)
            {
                if (CustomThemePanel != null) CustomThemePanel.Visibility = Visibility.Visible;
                if (ThemesListBox != null) ThemesListBox.Visibility = Visibility.Collapsed;
                _currentTheme = "Custom";
                UpdatePalettePreview(null!);
            }
            else
            {
                if (CustomThemePanel != null) CustomThemePanel.Visibility = Visibility.Collapsed;
                if (ThemesListBox != null) ThemesListBox.Visibility = Visibility.Visible;
                
                if (ThemesListBox?.SelectedItem is ThemeItem selected)
                {
                    _currentTheme = selected.Id;
                    UpdatePalettePreview(selected);
                }
            }
            
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

    private void UpdatePalettePreview(ThemeItem? theme)
    {
        var palette = new System.Collections.Generic.List<ColorPreviewItem>();
        
        System.Windows.Media.SolidColorBrush bg, editorBg, titleBar, statusBar, text, tabBg, selectedTab;

        if (_currentTheme == "Custom" || UseCustomThemeCheckBox.IsChecked == true)
        {
            bg = GetBrushFromHex(CustomBgHex.Text);
            editorBg = GetBrushFromHex(CustomEditorBgHex.Text);
            titleBar = GetBrushFromHex(CustomTitleBarHex.Text);
            statusBar = GetBrushFromHex(CustomStatusBarHex.Text);
            text = GetBrushFromHex(CustomTextHex.Text);
            tabBg = GetBrushFromHex(CustomTabBgHex.Text);
            selectedTab = GetBrushFromHex(CustomSelectedTabHex.Text);
        }
        else if (theme != null)
        {
            bg = theme.Background;
            editorBg = theme.EditorBackground;
            titleBar = theme.TitleBarBackground;
            statusBar = theme.StatusBarBackground;
            text = theme.Foreground;
            tabBg = theme.TabBackground;
            selectedTab = theme.SelectedTabBackground;
        }
        else return;

        palette.Add(new ColorPreviewItem { Label = "Window Background", Color = bg });
        palette.Add(new ColorPreviewItem { Label = "Editor Background", Color = editorBg });
        palette.Add(new ColorPreviewItem { Label = "Title Bar", Color = titleBar });
        palette.Add(new ColorPreviewItem { Label = "Status Bar", Color = statusBar });
        palette.Add(new ColorPreviewItem { Label = "Foreground Text", Color = text });
        palette.Add(new ColorPreviewItem { Label = "Tab Background", Color = tabBg });
        palette.Add(new ColorPreviewItem { Label = "Selected Tab", Color = selectedTab });
        
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
            "OrangeBurnout" => "Orange Burnout",
            "Custom" => "Custom Theme",
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
            bool useCustom = UseCustomThemeCheckBox.IsChecked == true;
            
            if (useCustom)
            {
                SaveGeneralPreference("Custom_Bg", CustomBgHex.Text);
                SaveGeneralPreference("Custom_EditorBg", CustomEditorBgHex.Text);
                SaveGeneralPreference("Custom_TitleBar", CustomTitleBarHex.Text);
                SaveGeneralPreference("Custom_StatusBar", CustomStatusBarHex.Text);
                SaveGeneralPreference("Custom_Text", CustomTextHex.Text);
                SaveGeneralPreference("Custom_TabBg", CustomTabBgHex.Text);
                SaveGeneralPreference("Custom_SelectedTab", CustomSelectedTabHex.Text);
                
                if (BracketThemesListBox.SelectedItem is BracketThemeItem selectedBracketTheme)
                {
                    bool overrideBrackets = OverrideBracketsCheckBox.IsChecked == true;
                    SavePreferences("Custom", selectedBracketTheme.Id, overrideBrackets);
                }
                else
                {
                    _currentTheme = "Custom";
                    SaveGeneralPreference("Theme", "Custom");
                    SaveGeneralPreference("UseCustomTheme", "True");
                }
                
                // Apply theme to resources
                ThemeManager.ApplyTheme("Custom");
                
                // Update open editors in MainWindow
                ApplyTheme("Custom");
                
                UpdatePalettePreview(null!);
                UpdateCurrentThemeText();
                
                MessageBox.Show("Custom theme settings applied successfully!", "Applied", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else if (ThemesListBox?.SelectedItem is ThemeItem selectedTheme && 
                BracketThemesListBox?.SelectedItem is BracketThemeItem selectedBracketTheme)
            {
                bool overrideBrackets = OverrideBracketsCheckBox.IsChecked == true;
                SavePreferences(selectedTheme.Id, selectedBracketTheme.Id, overrideBrackets);
                
                // Apply theme to resources
                ThemeManager.ApplyTheme(selectedTheme.Id);
                
                // Update open editors in MainWindow
                ApplyTheme(selectedTheme.Id);
                
                UpdatePalettePreview(selectedTheme);
                UpdateCurrentThemeText();
                
                Logger.Info($"Applied preferences: Theme={selectedTheme.Id}, BracketTheme={selectedBracketTheme.Id}, Override={overrideBrackets}");
                MessageBox.Show("Settings applied successfully!", "Applied", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply theme", ex);
            MessageBox.Show("Failed to apply theme. Please try again.", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnRoundedCornersToggle(object sender, RoutedEventArgs e)
    {
        bool isRounded = RoundedCornersCheckBox.IsChecked == true;
        Application.Current.Resources["GlobalCornerRadius"] = new CornerRadius(isRounded ? 3 : 0);
        
        // Save to preferences
        SaveGeneralPreference("RoundedEdges", isRounded.ToString());
    }

    private void SaveGeneralPreference(string key, string value)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new System.Collections.Generic.List<string>();
            
            if (File.Exists(prefsFile))
            {
                lines.AddRange(File.ReadAllLines(prefsFile));
            }
            
            bool found = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith($"{key}="))
                {
                    lines[i] = $"{key}={value}";
                    found = true;
                    break;
                }
            }
            
            if (!found)
            {
                lines.Add($"{key}={value}");
            }
            
            File.WriteAllLines(prefsFile, lines);
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to save {key} preference", ex);
        }
    }

    private void OnClose(object sender, RoutedEventArgs e)
    {
        Close();
    }
    


    private void OnCustomThemeToggle(object sender, RoutedEventArgs e)
    {
        if (CustomThemePanel == null || ThemesListBox == null) return;

        bool useCustom = UseCustomThemeCheckBox.IsChecked == true;
        CustomThemePanel.Visibility = useCustom ? Visibility.Visible : Visibility.Collapsed;
        ThemesListBox.Visibility = useCustom ? Visibility.Collapsed : Visibility.Visible;
        
        // Ensure preview panel is always visible
        if (PreviewPanelBorder != null) PreviewPanelBorder.Visibility = Visibility.Visible;
        
        SaveGeneralPreference("UseCustomTheme", useCustom.ToString());
        
        if (useCustom)
        {
            _currentTheme = "Custom";
            UpdateCurrentThemeText();
            
            // If custom colors are default/empty, populate from currently selected theme
            if (string.IsNullOrWhiteSpace(CustomBgHex.Text) || CustomBgHex.Text == "#0F1928")
            {
                if (ThemesListBox.SelectedItem is ThemeItem selectedTheme)
                {
                    CustomBgHex.Text = ColorToHex(selectedTheme.Background.Color);
                    CustomEditorBgHex.Text = ColorToHex(selectedTheme.EditorBackground.Color);
                    CustomTitleBarHex.Text = ColorToHex(selectedTheme.TitleBarBackground.Color);
                    CustomStatusBarHex.Text = ColorToHex(selectedTheme.StatusBarBackground.Color); 
                    CustomTextHex.Text = ColorToHex(selectedTheme.Foreground.Color);
                    CustomTabBgHex.Text = ColorToHex(selectedTheme.TabBackground.Color);
                    CustomSelectedTabHex.Text = ColorToHex(selectedTheme.SelectedTabBackground.Color);
                }
            }
            UpdatePalettePreview(null);
        }
        else
        {
            if (ThemesListBox.SelectedItem is ThemeItem selectedTheme)
            {
                _currentTheme = selectedTheme.Id;
                UpdateCurrentThemeText();
                UpdatePalettePreview(selectedTheme);
            }
        }
    }

    private string ColorToHex(System.Windows.Media.Color color)
    {
        return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
    }

    private void OnCustomColorChanged(object sender, TextChangedEventArgs e)
    {
        if (_currentTheme == "Custom")
        {
            UpdatePalettePreview(null!);
        }
    }

    private void OnPickColor(object sender, RoutedEventArgs e)
    {
        if (sender is System.Windows.Controls.Button button && button.Tag is string targetName)
        {
            var textBox = this.FindName(targetName) as System.Windows.Controls.TextBox;
            if (textBox != null)
            {
                if (ShowColorPickerDialog(textBox.Text, out string newHex))
                {
                    textBox.Text = newHex;
                }
            }
        }
    }

    private void OnColorPreviewClick(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement element && element.Tag is string targetName)
        {
            var textBox = this.FindName(targetName) as System.Windows.Controls.TextBox;
            if (textBox != null)
            {
                if (ShowColorPickerDialog(textBox.Text, out string newHex))
                {
                    textBox.Text = newHex;
                }
            }
        }
    }

    private bool ShowColorPickerDialog(string currentHex, out string newHex)
    {
        newHex = currentHex;
        try
        {
            using var dialog = new System.Windows.Forms.ColorDialog();
            dialog.FullOpen = true;
            
            try
            {
                var currentBrush = GetBrushFromHex(currentHex);
                var color = currentBrush.Color;
                dialog.Color = System.Drawing.Color.FromArgb(color.A, color.R, color.G, color.B);
            }
            catch { }

            if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
            {
                newHex = $"#{dialog.Color.R:X2}{dialog.Color.G:X2}{dialog.Color.B:X2}";
                return true;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to show color picker dialog", ex);
        }
        return false;
    }



    private void LoadCustomThemeSettings()
    {
        try
        {
            CustomBgHex.Text = ReadPreference("Custom_Bg", "#0F1928");
            CustomEditorBgHex.Text = ReadPreference("Custom_EditorBg", "#141E2D");
            CustomTitleBarHex.Text = ReadPreference("Custom_TitleBar", "#0F1928");
            CustomStatusBarHex.Text = ReadPreference("Custom_StatusBar", "#005A9E");
            CustomTextHex.Text = ReadPreference("Custom_Text", "#D4D4D4");
            CustomTabBgHex.Text = ReadPreference("Custom_TabBg", "#1E1E1E");
            CustomSelectedTabHex.Text = ReadPreference("Custom_SelectedTab", "#007ACC");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load custom theme settings", ex);
        }
    }
    private string ReadPreference(string key, string defaultValue)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (!File.Exists(prefsFile)) return defaultValue;

            var lines = File.ReadAllLines(prefsFile);
            foreach (var line in lines)
            {
                if (line.StartsWith($"{key}="))
                {
                    return line.Substring(key.Length + 1).Trim();
                }
            }
        }
        catch { }
        return defaultValue;
    }


}

public class InverseBooleanConverter : System.Windows.Data.IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
    {
        if (value is bool b)
        {
            bool result = !b;
            if (parameter?.ToString() == "Visibility")
            {
                return result ? Visibility.Visible : Visibility.Collapsed;
            }
            return result;
        }
        return value;
    }

    public object ConvertBack(object value, Type targetType, object parameter, System.Globalization.CultureInfo culture)
    {
        if (value is bool b) return !b;
        if (value is Visibility v) return v != Visibility.Visible;
        return value;
    }
}
