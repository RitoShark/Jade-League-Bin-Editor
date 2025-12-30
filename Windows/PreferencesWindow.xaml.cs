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

            var stickyScroll = ThemeHelper.ReadPreference("StickyScroll", "False");
            StickyScrollCheckBox.IsChecked = stickyScroll.Equals("True", StringComparison.OrdinalIgnoreCase);
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

    private void OnStickyScrollChanged(object sender, RoutedEventArgs e)
    {
        try
        {
            var isChecked = StickyScrollCheckBox.IsChecked ?? false;
            ThemeHelper.WritePreference("StickyScroll", isChecked.ToString());
            Logger.Info($"StickyScroll preference set to: {isChecked}");
            
            // Notify MainWindow if it's open (it should be)
            foreach (Window window in Application.Current.Windows)
            {
                if (window is MainWindow main)
                {
                    main.UpdateStickyScrollVisibility();
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save StickyScroll preference", ex);
        }
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
}
