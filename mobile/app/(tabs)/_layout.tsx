import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colour } from "../../lib/theme";

/**
 * Four tabs, in the order they are reached for: what the robot is doing, what
 * it produced, where it can go, and who you are. Anything deeper — a single
 * session — is a push, because it is a place you come back from.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colour.background },
        headerTintColor: colour.text,
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: "600" },
        tabBarStyle: {
          backgroundColor: colour.card,
          borderTopColor: colour.border,
          paddingTop: 6,
          height: 88,
        },
        tabBarActiveTintColor: colour.signal,
        tabBarInactiveTintColor: colour.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        sceneStyle: { backgroundColor: colour.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sessions",
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="files"
        options={{
          title: "Files",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="sites"
        options={{
          title: "Sites",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="globe-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
