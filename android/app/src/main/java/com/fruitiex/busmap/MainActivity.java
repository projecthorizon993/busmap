package com.fruitiex.busmap;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.geolocation.Geolocation;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Register plugins
        registerPlugin(Geolocation.class);
    }
}
