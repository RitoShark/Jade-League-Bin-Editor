using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Controls;
using Jade.Services;

namespace Jade.Windows;

public partial class PreferencesWindow : Window
{
    public PreferencesWindow()
    {
        InitializeComponent();
        ApplyWindowTheme(GetCurrentTheme());
        LoadPreferences();
    }

    private void LoadPreferences()
    {
        try
        {
            var importLinked = ThemeHelper.ReadPreference("ImportLinkedBins", "False");
            ImportLinkedBinsCheckBox.IsChecked = importLinked.Equals("True", StringComparison.OrdinalIgnoreCase);
            
            var recursiveLinked = ThemeHelper.ReadPreference("RecursiveLinkedBins", "False");
            RecursiveLinkedBinsCheckBox.IsChecked = recursiveLinked.Equals("True", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load preferences", ex);
        }
    }

    private void OnImportLinkedBinsChanged(object sender, RoutedEventArgs e)
    {
        try
        {
            var isChecked = ImportLinkedBinsCheckBox.IsChecked ?? false;
            ThemeHelper.WritePreference("ImportLinkedBins", isChecked.ToString());
            Logger.Info($"ImportLinkedBins preference set to: {isChecked}");
            
            // If unchecked, also uncheck the recursive option
            if (!isChecked && RecursiveLinkedBinsCheckBox.IsChecked == true)
            {
                RecursiveLinkedBinsCheckBox.IsChecked = false;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save ImportLinkedBins preference", ex);
        }
    }

    private void OnRecursiveLinkedBinsChanged(object sender, RoutedEventArgs e)
    {
        try
        {
            var isChecked = RecursiveLinkedBinsCheckBox.IsChecked ?? false;
            ThemeHelper.WritePreference("RecursiveLinkedBins", isChecked.ToString());
            Logger.Info($"RecursiveLinkedBins preference set to: {isChecked}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save RecursiveLinkedBins preference", ex);
        }
    }

    private string GetCurrentTheme()
    {
        return ThemeHelper.ReadPreference("Theme", "Default");
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left)
            this.DragMove();
    }

    private void OnClose(object sender, RoutedEventArgs e)
    {
        this.Close();
    }

    private void ApplyWindowTheme(string theme)
    {
        try
        {
            SolidColorBrush bgColor, titleBarBg, textColor;
            
            if (theme == "DarkBlue")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(20, 30, 45));
                titleBarBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
                textColor = new SolidColorBrush(Color.FromRgb(220, 230, 240));
            }
            else if (theme == "DarkRed")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(45, 20, 25));
                titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
                textColor = new SolidColorBrush(Color.FromRgb(240, 220, 225));
            }
            else if (theme == "LightPink")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(210, 165, 190));
                titleBarBg = new SolidColorBrush(Color.FromRgb(180, 130, 160));
                textColor = Brushes.Black;
            }
            else if (theme == "PastelBlue")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(210, 240, 255));
                titleBarBg = new SolidColorBrush(Color.FromRgb(255, 240, 250));
                textColor = Brushes.Black;
            }
            else if (theme == "ForestGreen")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(25, 45, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
                textColor = new SolidColorBrush(Color.FromRgb(200, 230, 210));
            }
            else if (theme == "AMOLED")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(0, 0, 0));
                titleBarBg = new SolidColorBrush(Color.FromRgb(10, 10, 10));
                textColor = new SolidColorBrush(Color.FromRgb(180, 180, 180));
            }
            else if (theme == "Void")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(15, 10, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(20, 15, 40));
                textColor = new SolidColorBrush(Color.FromRgb(180, 170, 220));
            }
            else if (theme == "VioletSorrow")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(22, 12, 42));
                titleBarBg = new SolidColorBrush(Color.FromRgb(28, 18, 52));
                textColor = new SolidColorBrush(Color.FromRgb(185, 170, 215));
            }
            else if (theme == "OrangeBurnout")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(35, 15, 5));
                titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 10));
                textColor = new SolidColorBrush(Color.FromRgb(255, 228, 209));
            }
            else if (theme == "PurpleGrief")
            {
                bgColor = new SolidColorBrush(Color.FromRgb(25, 15, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(35, 25, 40));
                textColor = new SolidColorBrush(Color.FromRgb(220, 200, 230));
            }
            else if (theme == "Custom")
            {
                bgColor = ThemeHelper.GetBrushFromHex(ThemeHelper.ReadPreference("Custom_Bg", "#0F1928"));
                titleBarBg = ThemeHelper.GetBrushFromHex(ThemeHelper.ReadPreference("Custom_TitleBar", "#0F1928"));
                textColor = ThemeHelper.GetBrushFromHex(ThemeHelper.ReadPreference("Custom_Text", "#D4D4D4"));
            }
            else // Default
            {
                bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
                textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
            }
            
            this.Background = bgColor;
            TitleBar.Background = titleBarBg;
            
            // Update borders/boxes if any (we have one in Row 2)
            // Update borders/boxes
            if (ContentBorder != null)
            {
                ContentBorder.Background = titleBarBg;
                ContentBorder.BorderBrush = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255));
            }
            // UpdateContainerColors(this, titleBarBg); // Removed effectively
            
            // Update all TextBlocks
            UpdateTextBlockColors(this, textColor);
            
            // Update buttons
            UpdateItemStyles(this, titleBarBg, textColor);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply window theme to PreferencesWindow", ex);
        }
    }

    private void UpdateContainerColors(DependencyObject parent, SolidColorBrush background)
    {
        int childCount = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is Border border && border.Name != "TitleBar" && border != this.Content)
            {
                border.Background = background;
                border.BorderBrush = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255));
            }
            UpdateContainerColors(child, background);
        }
    }

    private void UpdateTextBlockColors(DependencyObject parent, SolidColorBrush color)
    {
        int childCount = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is TextBlock textBlock)
            {
                textBlock.Foreground = color;
            }
            UpdateTextBlockColors(child, color);
        }
    }

    private void UpdateItemStyles(DependencyObject parent, SolidColorBrush bg, SolidColorBrush fg)
    {
        int childCount = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is Button button)
            {
                button.Foreground = fg;
                // Only update background if it's not the default gray
                if (button.Background is SolidColorBrush scb && scb.Color == Color.FromRgb(62, 62, 66))
                {
                    // Keep it
                }
            }
            else if (child is CheckBox checkBox)
            {
                checkBox.Foreground = fg;
            }
            UpdateItemStyles(child, bg, fg);
        }
    }
}
