// Copyright (c) 2025 Eclipse Foundation.
// SPDX-License-Identifier: MIT

const DEFAULT_PYTHON_APP = `import time
import asyncio
import signal

from sdv.vdb.reply import DataPointReply
from sdv.vehicle_app import VehicleApp
from vehicle import Vehicle, vehicle

class TestApp(VehicleApp):

    def __init__(self, vehicle_client: Vehicle):
        super().__init__()
        self.Vehicle = vehicle_client

    async def on_start(self):
        # on app started, this function will be trigger, your logic SHOULD start from HERE
        while True:
            # sleep for 2 second
            await asyncio.sleep(2)
            # write an actuator signal with value
            await self.Vehicle.Body.Lights.Beam.Low.IsOn.set(True)
            await asyncio.sleep(1)
            # read an actuator back
            value = (await self.Vehicle.Body.Lights.Beam.Low.IsOn.get()).value
            print("Light value ", value)

            await asyncio.sleep(2)
            # write an actuator signal with value
            await self.Vehicle.Body.Lights.Beam.Low.IsOn.set(False)
            await asyncio.sleep(1)
            # read an actuator back
            value = (await self.Vehicle.Body.Lights.Beam.Low.IsOn.get()).value
            print("Light value ", value)

async def main():
    vehicle_app = TestApp(vehicle)
    await vehicle_app.run()


LOOP = asyncio.get_event_loop()
LOOP.add_signal_handler(signal.SIGTERM, LOOP.stop)
LOOP.run_until_complete(main())
LOOP.close()`;

const PYTHON_MULTI_FILES = [
  {
    type: 'folder',
    name: 'python-project',
    items: [
      {
        type: 'file',
        name: 'README.md',
        content:
          '# Python Project\n\nA simple Python project with multiple files.\n\n## Features\n- Multiple Python modules\n- Configuration file\n- Requirements file\n- Basic project structure',
      },
      { type: 'file', name: 'requirements.txt', content: 'requests==2.31.0' },
      { type: 'file', name: 'main.py', content: DEFAULT_PYTHON_APP },
    ],
  },
];

const DEFAULT_RUST_MAIN = `use std::collections::HashMap;
use std::thread;
use std::time::Duration;

// ===== Enum =====
#[derive(Debug)]
enum Status {
    Idle,
    Running,
}

// ===== Struct / object =====
#[derive(Debug)]
struct Sensor {
    id: i32,
    value: f32,
    active: bool,
}

fn main() {
    // ===== Primitives =====
    let mut n_int = 42;
    let mut pi_float = 3.14159;
    let _is_enabled = true;
    let _name = String::from("autowrx");

    // ===== Container =====
    let mut nums = vec![1, 2, 3];
    let mut config = HashMap::new();
    config.insert(String::from("retry"), 3);

    // ===== Enum =====
    let status = Status::Running;

    // ===== Object =====
    let sensor = Sensor {
        id: 1,
        value: 88.6,
        active: true,
    };

    let mut counter = 0;

    loop {
        counter += 1;

        n_int += 1;
        pi_float += 0.01;

        nums[0] = counter % 10;

        let retry = *config.get("retry").unwrap_or(&0);
        config.insert(String::from("retry"), (retry % 5) + 1);

        println!("counter={}", counter);

        /*
        println!(
            "tick={}, n_int={}, pi_float={}, nums=[{},{},{}], retry={}, status={:?}, sensor={{id={}, value={}, active={}}}",
            counter,
            n_int,
            pi_float,
            nums[0], nums[1], nums[2],
            config.get("retry").unwrap_or(&0),
            status,
            sensor.id, sensor.value, sensor.active
        );
        */

        thread::sleep(Duration::from_secs(1));
    }
}`;

const RUST_MULTI_FILES = [
  {
    type: 'folder',
    name: 'rust-project',
    items: [
      {
        type: 'file',
        name: 'Cargo.toml',
        content: '[package]\nname = "rust_project"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      },
      {
        type: 'file',
        name: 'README.md',
        content: '# Rust Project\n\nMinimal Rust template.\n',
      },
      {
        type: 'folder',
        name: 'src',
        items: [
          {
            type: 'file',
            name: 'main.rs',
            content: DEFAULT_RUST_MAIN,
          },
        ],
      },
    ],
  },
];

const DEFAULT_CPP_MAIN = `#include <iostream>
#include <vector>
#include <map>
#include <string>
#include <thread>
#include <chrono>
 
// ===== Enum =====
enum class Status {
    IDLE,
    RUNNING
};
 
// Convert enum -> string
std::string statusToString(Status s) {
    switch (s) {
        case Status::IDLE: return "idle";
        case Status::RUNNING: return "running";
        default: return "unknown";
    }
}
 
// ===== Struct / object =====
struct Sensor {
    int id;
    float value;
    bool active;
};
 
int main() {
    // ===== Primitives =====
    int n_int = 42;
    double pi_float = 3.14159;
    bool is_enabled = true;
    std::string name = "autowrx";
 
    // ===== Container =====
    std::vector<int> nums = {1, 2, 3};
    std::map<std::string, int> config = {
        {"retry", 3}
    };
 
    // ===== Enum =====
    Status status = Status::RUNNING;
 
    // ===== Object =====
    Sensor sensor = {1, 88.6f, true};
 
    int counter = 0;
 
    while (true) {
        counter++;
 
        n_int += 1;
        pi_float += 0.01;
 
        nums[0] = counter % 10;
 
        config["retry"] = (config["retry"] % 5) + 1;
 
        std::cout << "counter=" << counter << std::endl;
 
        /*
        std::cout
            << "tick=" << counter
            << ", n_int=" << n_int
            << ", pi_float=" << pi_float
            << ", nums=[" << nums[0] << "," << nums[1] << "," << nums[2] << "]"
            << ", retry=" << config["retry"]
            << ", status=" << statusToString(status)
            << ", sensor={id=" << sensor.id
            << ", value=" << sensor.value
            << ", active=" << std::boolalpha << sensor.active
            << "}"
            << std::endl;
        */
 
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
 
    return 0;
}`;

const CPP_MULTI_FILES = [
  {
    type: 'folder',
    name: 'cpp-project',
    items: [
      {
        type: 'file',
        name: 'CMakeLists.txt',
        content:
          'cmake_minimum_required(VERSION 3.16)\nproject(cpp_project)\n\nset(CMAKE_CXX_STANDARD 17)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\n\nfind_package(Threads REQUIRED)\n\nadd_executable(main src/main.cpp)\ntarget_link_libraries(main PRIVATE Threads::Threads)\n',
      },
      {
        type: 'file',
        name: 'README.md',
        content: '# C++ Project\n\nMinimal C++ template.\n',
      },
      {
        type: 'folder',
        name: 'src',
        items: [
          {
            type: 'file',
            name: 'main.cpp',
            content: DEFAULT_CPP_MAIN,
          },
        ],
      },
    ],
  },
];

const DEFAULT_WIDGET_CONFIG = JSON.stringify({
  autorun: false,
  widgets: [
    {
      plugin: 'Builtin',
      widget: 'Embedded-Widget',
      options: {
        api: 'Vehicle.Body.Lights.Beam.Low.IsOn',
        defaultImgUrl: 'https://bestudio.digitalauto.tech/project/Ml2Sc9TYoOHc/light_off.png',
        displayExactMatch: true,
        valueMaps: [
          {
            value: true,
            imgUrl: 'https://bestudio.digitalauto.tech/project/Ml2Sc9TYoOHc/light_on.png',
          },
          {
            value: false,
            imgUrl: 'https://bestudio.digitalauto.tech/project/Ml2Sc9TYoOHc/light_off.png',
          },
        ],
        url: 'https://store-be.digitalauto.tech/data/store-be/Image%20by%20Signal%20value/latest/index/index.html',
        iconURL: 'https://upload.digitalauto.tech/data/store-be/3c3685b3-0b58-4f75-820e-9af0180cf3f0.png',
      },
      boxes: [2, 3, 7, 8],
      path: '',
    },
    {
      plugin: 'Builtin',
      widget: 'Embedded-Widget',
      options: {
        url: 'https://store-be.digitalauto.tech/data/store-be/Terminal/latest/terminal/index.html',
        iconURL: 'https://upload.digitalauto.tech/data/store-be/e991ea29-5fbf-42e9-9d3d-cceae23600f0.png',
      },
      boxes: [1, 6],
      path: '',
    },
    {
      plugin: 'Builtin',
      widget: 'Embedded-Widget',
      options: {
        api: 'Vehicle.Body.Lights.Beam.Low.IsOn',
        lineColor: '#005072',
        dataUpdateInterval: '1000',
        maxDataPoints: '30',
        url: 'https://store-be.digitalauto.tech/data/store-be/Chart%20Signal%20Widget/latest/index/index.html',
        iconURL: 'https://upload.digitalauto.tech/data/store-be/f25ceb29-b9e8-470e-897a-4d843e16a0cf.png',
      },
      boxes: [4, 5],
      path: '',
    },
    {
      plugin: 'Builtin',
      widget: 'Embedded-Widget',
      options: {
        apis: ['Vehicle.Body.Lights.Beam.Low.IsOn'],
        vss_json: 'https://bewebstudio.digitalauto.tech/data/projects/sHQtNwric0H7/vss_rel_4.0.json',
        url: 'https://store-be.digitalauto.tech/data/store-be/Signal%20List%20Settable/latest/table-settable/index.html',
        iconURL: 'https://upload.digitalauto.tech/data/store-be/dccabc84-2128-4e5d-9e68-bc20333441c4.png',
      },
      boxes: [9, 10],
      path: '',
    },
  ],
});

const PREDEFINED_PROJECT_TEMPLATES = [
  {
    name: 'Python Multiple Files (Beta)',
    description: 'A simple Python project with multiple files demonstrating basic structure',
    data: JSON.stringify({
      language: 'python',
      code: JSON.stringify(PYTHON_MULTI_FILES),
      widget_config: DEFAULT_WIDGET_CONFIG,
    }),
  },
  {
    name: 'Rust Project (Beta)',
    description: 'A minimal Rust template project',
    data: JSON.stringify({
      language: 'rust',
      code: JSON.stringify(RUST_MULTI_FILES),
      widget_config: DEFAULT_WIDGET_CONFIG,
    }),
  },
  {
    name: 'C++ Project (Beta)',
    description: 'A minimal C++ template project',
    data: JSON.stringify({
      language: 'cpp',
      code: JSON.stringify(CPP_MULTI_FILES),
      widget_config: DEFAULT_WIDGET_CONFIG,
    }),
  },
  {
    name: 'Empty Project',
    description: 'Empty project with no code',
    data: JSON.stringify({
      language: 'python',
      code: '',
      widget_config: '{"autorun": false, "widgets": []}',
      customer_journey: ' ',
    }),
  },
];

module.exports = PREDEFINED_PROJECT_TEMPLATES;
