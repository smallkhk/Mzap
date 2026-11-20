import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: '#161618' },
          headerTintColor: '#e8e8ea',
          tabBarStyle: { backgroundColor: '#161618', borderTopColor: '#2a2a2e' },
          tabBarActiveTintColor: '#5b9dff',
          tabBarInactiveTintColor: '#7a7a82',
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Send' }} />
        <Tabs.Screen name="history" options={{ title: 'History' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </>
  );
}
