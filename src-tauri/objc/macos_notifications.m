#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

// Status codes shared with src-tauri/src/macos_notifications.rs.
static const int32_t GRAPHER_NOTIF_STATUS_UNAVAILABLE = -1;
static const int32_t GRAPHER_NOTIF_STATUS_NOT_DETERMINED = 0;
static const int32_t GRAPHER_NOTIF_STATUS_DENIED = 1;
static const int32_t GRAPHER_NOTIF_STATUS_AUTHORIZED = 2;

// Delivery result codes shared with src-tauri/src/macos_notifications.rs.
static const int32_t GRAPHER_NOTIF_DELIVER_ERROR = -2;
static const int32_t GRAPHER_NOTIF_DELIVER_UNAVAILABLE = -1;
static const int32_t GRAPHER_NOTIF_DELIVER_DENIED = 0;
static const int32_t GRAPHER_NOTIF_DELIVER_SENT = 1;

extern void grapher_macos_notification_clicked(const char *run_id_utf8);

typedef void (*GrapherStatusCallback)(void *ctx, int32_t status);
typedef void (*GrapherDeliverCallback)(void *ctx, int32_t result, const char *error_msg);

static bool grapher_has_valid_app_bundle(void) {
    NSBundle *bundle = [NSBundle mainBundle];
    if (bundle == nil) {
        return false;
    }
    NSString *bundleId = bundle.bundleIdentifier;
    if (bundleId == nil || bundleId.length == 0) {
        return false;
    }
    NSString *ext = bundle.bundleURL.pathExtension;
    return ext != nil && [ext caseInsensitiveCompare:@"app"] == NSOrderedSame;
}

static int32_t map_authorization_status(UNAuthorizationStatus status) {
    switch (status) {
        case UNAuthorizationStatusAuthorized:
        case UNAuthorizationStatusProvisional:
            return GRAPHER_NOTIF_STATUS_AUTHORIZED;
        case UNAuthorizationStatusDenied:
            return GRAPHER_NOTIF_STATUS_DENIED;
        case UNAuthorizationStatusNotDetermined:
        default:
            return GRAPHER_NOTIF_STATUS_NOT_DETERMINED;
    }
}

@interface GrapherNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
+ (instancetype)sharedDelegate;
@end

@implementation GrapherNotificationDelegate

+ (instancetype)sharedDelegate {
    static GrapherNotificationDelegate *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[GrapherNotificationDelegate alloc] init];
    });
    return instance;
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    (void)center;
    // The Rust command already suppresses notifications when the main window is
    // visible and focused. Allow banners even while Grapher remains the active
    // app (for example after hiding the main window on close), and respect the
    // per-notification sound preference.
    UNNotificationPresentationOptions options =
        UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
    if (notification.request.content.sound != nil) {
        options |= UNNotificationPresentationOptionSound;
    }
    completionHandler(options);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    (void)center;
    NSDictionary *userInfo = response.notification.request.content.userInfo;
    id rawRunId = userInfo[@"runId"];
    NSString *runId = [rawRunId isKindOfClass:[NSString class]] ? (NSString *)rawRunId : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
        // Avoid `@available(...)`, which emits `___isPlatformVersionAtLeast` from
        // `libclang_rt.osx.a` and fails to link under Rust's `-nodefaultlibs`.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        if ([NSApp respondsToSelector:@selector(activate)]) {
            [NSApp activate];
        } else {
            [NSApp activateIgnoringOtherApps:YES];
        }
#pragma clang diagnostic pop
        grapher_macos_notification_clicked(runId ? runId.UTF8String : NULL);
    });
    completionHandler();
}

@end

static UNUserNotificationCenter *safe_notification_center(void) {
    if (!grapher_has_valid_app_bundle()) {
        return nil;
    }
    @try {
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        if (center != nil) {
            static dispatch_once_t delegateToken;
            dispatch_once(&delegateToken, ^{
                center.delegate = [GrapherNotificationDelegate sharedDelegate];
            });
        }
        return center;
    } @catch (NSException *exception) {
        fprintf(
            stderr,
            "[grapher-desktop] UNUserNotificationCenter unavailable: %s\n",
            exception.reason ? exception.reason.UTF8String : "unknown exception"
        );
        return nil;
    }
}

bool grapher_macos_init_notifications(void) {
    @autoreleasepool {
        return safe_notification_center() != nil;
    }
}

void grapher_macos_get_permission_status(void *ctx, GrapherStatusCallback cb) {
    @autoreleasepool {
        UNUserNotificationCenter *center = safe_notification_center();
        if (center == nil) {
            cb(ctx, GRAPHER_NOTIF_STATUS_UNAVAILABLE);
            return;
        }
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            cb(ctx, map_authorization_status(settings.authorizationStatus));
        }];
    }
}

static void request_authorization_on_main(
    UNUserNotificationCenter *center,
    void (^completion)(int32_t status)
) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UNAuthorizationOptions options =
            UNAuthorizationOptionAlert |
            UNAuthorizationOptionSound |
            UNAuthorizationOptionBadge;
        [center requestAuthorizationWithOptions:options
                              completionHandler:^(BOOL granted, NSError * _Nullable error) {
            if (error != nil) {
                fprintf(
                    stderr,
                    "[grapher-desktop] Failed to request macOS notification permission: %s\n",
                    error.localizedDescription.UTF8String
                );
            }
            if (granted) {
                completion(GRAPHER_NOTIF_STATUS_AUTHORIZED);
                return;
            }
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                completion(map_authorization_status(settings.authorizationStatus));
            }];
        }];
    });
}

void grapher_macos_request_permission(void *ctx, GrapherStatusCallback cb) {
    @autoreleasepool {
        UNUserNotificationCenter *center = safe_notification_center();
        if (center == nil) {
            cb(ctx, GRAPHER_NOTIF_STATUS_UNAVAILABLE);
            return;
        }
        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            int32_t current = map_authorization_status(settings.authorizationStatus);
            if (current != GRAPHER_NOTIF_STATUS_NOT_DETERMINED) {
                cb(ctx, current);
                return;
            }
            request_authorization_on_main(center, ^(int32_t updated) {
                cb(ctx, updated);
            });
        }];
    }
}

static void deliver_un_notification(
    UNUserNotificationCenter *center,
    NSString *title,
    NSString *body,
    NSString * _Nullable runId,
    bool playSound,
    void *ctx,
    GrapherDeliverCallback cb
) {
    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = title;
    content.body = body;
    content.sound = playSound ? [UNNotificationSound defaultSound] : nil;
    if (runId != nil && runId.length > 0) {
        content.userInfo = @{ @"runId": runId };
    }

    NSString *identifier = [[NSUUID UUID] UUIDString];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                          content:content
                                                                          trigger:nil];
    [center addNotificationRequest:request withCompletionHandler:^(NSError * _Nullable error) {
        if (error != nil) {
            const char *msg = error.localizedDescription.UTF8String;
            cb(ctx, GRAPHER_NOTIF_DELIVER_ERROR, msg ? msg : "Failed to deliver notification");
        } else {
            cb(ctx, GRAPHER_NOTIF_DELIVER_SENT, NULL);
        }
    }];
}

void grapher_macos_send_notification(
    const char *title_utf8,
    const char *body_utf8,
    const char *run_id_utf8,
    bool play_sound,
    void *ctx,
    GrapherDeliverCallback cb
) {
    @autoreleasepool {
        UNUserNotificationCenter *center = safe_notification_center();
        if (center == nil) {
            cb(ctx, GRAPHER_NOTIF_DELIVER_UNAVAILABLE, NULL);
            return;
        }
        NSString *title = title_utf8 ? [NSString stringWithUTF8String:title_utf8] : @"Grapher";
        NSString *body = body_utf8 ? [NSString stringWithUTF8String:body_utf8] : @"";
        NSString *runId = (run_id_utf8 && run_id_utf8[0] != '\0')
            ? [NSString stringWithUTF8String:run_id_utf8]
            : nil;
        if (title == nil) {
            title = @"Grapher";
        }
        if (body == nil) {
            body = @"";
        }

        [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
            int32_t current = map_authorization_status(settings.authorizationStatus);
            if (current == GRAPHER_NOTIF_STATUS_AUTHORIZED) {
                deliver_un_notification(center, title, body, runId, play_sound, ctx, cb);
            } else if (current == GRAPHER_NOTIF_STATUS_NOT_DETERMINED) {
                request_authorization_on_main(center, ^(int32_t updated) {
                    if (updated == GRAPHER_NOTIF_STATUS_AUTHORIZED) {
                        deliver_un_notification(center, title, body, runId, play_sound, ctx, cb);
                    } else {
                        cb(ctx, GRAPHER_NOTIF_DELIVER_DENIED, NULL);
                    }
                });
            } else {
                cb(ctx, GRAPHER_NOTIF_DELIVER_DENIED, NULL);
            }
        }];
    }
}
