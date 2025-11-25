package me.faeller.zulipnotifs;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // register custom plugin
        registerPlugin(ForegroundServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
